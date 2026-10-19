#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Agent, fetch as undiciFetch } from "undici";

// ── Config ────────────────────────────────────────────────────────────────────

const UNIFI_HOST = process.env.UNIFI_HOST;
const UNIFI_API_KEY = process.env.UNIFI_API_KEY;

if (!UNIFI_HOST) throw new Error("UNIFI_HOST environment variable is required.\n  Local:  https://192.168.1.1\n  Remote: https://api.ui.com");
if (!UNIFI_API_KEY) throw new Error("UNIFI_API_KEY environment variable is required");

// Detect whether we're talking to the cloud API or a local controller.
// Local gateway:  https://<ip>/proxy/network/integration/v1
// Cloud (ui.com): https://api.ui.com/api/v1
const isCloud = UNIFI_HOST.includes("ui.com");
const BASE = isCloud
  ? `${UNIFI_HOST}/api/v1`
  : `${UNIFI_HOST}/proxy/network/integration/v1`;

// Local controllers use self-signed TLS certs — skip verification.
// For the cloud API the cert is valid so rejectUnauthorized stays true.
const dispatcher = new Agent({ connect: { rejectUnauthorized: isCloud } });

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function unifiRequest(
  method: string,
  path: string,
  body?: unknown
): Promise<unknown> {
  const url = `${BASE}${path}`;
  const res = await undiciFetch(url, {
    method,
    headers: {
      "X-API-Key": UNIFI_API_KEY!,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    dispatcher,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`UniFi API error ${res.status}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(e: unknown) {
  return {
    content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }],
    isError: true as const,
  };
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new McpServer({ name: "unifi-mcp", version: "0.1.0" });

// Resolve the default site ID once at startup so tools work without it being passed.
let DEFAULT_SITE_ID = "default";
try {
  const sites = await unifiRequest("GET", "/sites") as { data?: Array<{ id: string }> };
  if (sites?.data?.[0]?.id) DEFAULT_SITE_ID = sites.data[0].id;
} catch {
  // non-fatal — tools will still work if siteId is passed explicitly
}

// ── Sites ─────────────────────────────────────────────────────────────────────

server.registerTool(
  "list_sites",
  {
    description: "List all sites on the UniFi controller. Returns siteIds needed for all other tools.",
    inputSchema: z.object({}),
  },
  async () => {
    try {
      const data = await unifiRequest("GET", "/sites");
      return ok(data);
    } catch (e) {
      return err(e);
    }
  }
);

// ── Networks ──────────────────────────────────────────────────────────────────

server.registerTool(
  "list_networks",
  {
    description: "List all configured networks (LAN/WAN/VLANs) on a UniFi site.",
    inputSchema: z.object({
      siteId: z.string().default(DEFAULT_SITE_ID).describe("Site ID (from list_sites). Defaults to the first site on the controller."),
    }),
  },
  async ({ siteId }) => {
    try {
      const data = await unifiRequest("GET", `/sites/${siteId}/networks`);
      return ok(data);
    } catch (e) {
      return err(e);
    }
  }
);

server.registerTool(
  "create_network",
  {
    description: "Create a new LAN network or VLAN on a UniFi site.",
    inputSchema: z.object({
      siteId: z.string().default(DEFAULT_SITE_ID).describe("Site ID (from list_sites). Defaults to the first site on the controller."),
      name: z.string().describe("Network name"),
      purpose: z.enum(["corporate", "guest", "vlan-only", "wan"]).default("corporate").describe("Network purpose"),
      vlanId: z.number().int().min(1).max(4094).optional().describe("VLAN ID (1-4094)"),
      ipSubnet: z.string().optional().describe("Subnet in CIDR notation, e.g. 192.168.10.1/24"),
      dhcpEnabled: z.boolean().default(true).describe("Enable DHCP server on this network"),
      dhcpStart: z.string().optional().describe("DHCP range start IP"),
      dhcpEnd: z.string().optional().describe("DHCP range end IP"),
    }),
  },
  async ({ siteId, name, purpose, vlanId, ipSubnet, dhcpEnabled, dhcpStart, dhcpEnd }) => {
    try {
      const payload: Record<string, unknown> = { name, purpose, dhcpEnabled };
      if (vlanId !== undefined) payload.vlanId = vlanId;
      if (ipSubnet) payload.ipSubnet = ipSubnet;
      if (dhcpStart) payload.dhcpStart = dhcpStart;
      if (dhcpEnd) payload.dhcpEnd = dhcpEnd;
      const data = await unifiRequest("POST", `/sites/${siteId}/networks`, payload);
      return ok(data);
    } catch (e) {
      return err(e);
    }
  }
);

server.registerTool(
  "update_network",
  {
    description: "Update an existing network by its ID.",
    inputSchema: z.object({
      siteId: z.string().default(DEFAULT_SITE_ID).describe("Site ID (from list_sites). Defaults to the first site on the controller."),
      networkId: z.string().describe("Network ID (from list_networks)"),
      name: z.string().optional().describe("New network name"),
      vlanId: z.number().int().min(1).max(4094).optional().describe("VLAN ID"),
      ipSubnet: z.string().optional().describe("Subnet in CIDR notation"),
      dhcpEnabled: z.boolean().optional().describe("Enable/disable DHCP server"),
      dhcpStart: z.string().optional().describe("DHCP range start IP"),
      dhcpEnd: z.string().optional().describe("DHCP range end IP"),
    }),
  },
  async ({ siteId, networkId, ...fields }) => {
    try {
      const payload = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      const data = await unifiRequest("PUT", `/sites/${siteId}/networks/${networkId}`, payload);
      return ok(data);
    } catch (e) {
      return err(e);
    }
  }
);

server.registerTool(
  "delete_network",
  {
    description: "Delete a network by its ID.",
    inputSchema: z.object({
      siteId: z.string().default(DEFAULT_SITE_ID).describe("Site ID (from list_sites). Defaults to the first site on the controller."),
      networkId: z.string().describe("Network ID (from list_networks)"),
    }),
  },
  async ({ siteId, networkId }) => {
    try {
      const data = await unifiRequest("DELETE", `/sites/${siteId}/networks/${networkId}`);
      return ok(data);
    } catch (e) {
      return err(e);
    }
  }
);

// ── Firewall Policies ─────────────────────────────────────────────────────────

server.registerTool(
  "list_firewall_rules",
  {
    description: "List all firewall policies/rules on a UniFi site.",
    inputSchema: z.object({
      siteId: z.string().default(DEFAULT_SITE_ID).describe("Site ID (from list_sites). Defaults to the first site on the controller."),
    }),
  },
  async ({ siteId }) => {
    try {
      const data = await unifiRequest("GET", `/sites/${siteId}/firewall-policies`);
      return ok(data);
    } catch (e) {
      return err(e);
    }
  }
);

server.registerTool(
  "create_firewall_rule",
  {
    description: "Create a new firewall policy/rule on a UniFi site.",
    inputSchema: z.object({
      siteId: z.string().default(DEFAULT_SITE_ID).describe("Site ID (from list_sites). Defaults to the first site on the controller."),
      name: z.string().describe("Rule name"),
      action: z.enum(["ACCEPT", "DROP", "REJECT"]).describe("Action to take"),
      protocol: z.enum(["all", "tcp", "udp", "tcp_udp", "icmp"]).default("all").describe("Protocol"),
      enabled: z.boolean().default(true).describe("Enable the rule"),
      sourceAddress: z.string().optional().describe("Source IP/CIDR"),
      destinationAddress: z.string().optional().describe("Destination IP/CIDR"),
      destinationPort: z.string().optional().describe("Destination port or range, e.g. '80' or '8000:9000'"),
      logging: z.boolean().default(false).describe("Enable logging for matched traffic"),
    }),
  },
  async ({ siteId, name, action, protocol, enabled, sourceAddress, destinationAddress, destinationPort, logging }) => {
    try {
      const payload: Record<string, unknown> = { name, action, protocol, enabled, logging };
      if (sourceAddress) payload.sourceAddress = sourceAddress;
      if (destinationAddress) payload.destinationAddress = destinationAddress;
      if (destinationPort) payload.destinationPort = destinationPort;
      const data = await unifiRequest("POST", `/sites/${siteId}/firewall-policies`, payload);
      return ok(data);
    } catch (e) {
      return err(e);
    }
  }
);

server.registerTool(
  "update_firewall_rule",
  {
    description: "Update an existing firewall policy/rule by its ID.",
    inputSchema: z.object({
      siteId: z.string().default(DEFAULT_SITE_ID).describe("Site ID (from list_sites). Defaults to the first site on the controller."),
      ruleId: z.string().describe("Firewall rule ID (from list_firewall_rules)"),
      name: z.string().optional(),
      action: z.enum(["ACCEPT", "DROP", "REJECT"]).optional(),
      enabled: z.boolean().optional(),
      protocol: z.enum(["all", "tcp", "udp", "tcp_udp", "icmp"]).optional(),
      sourceAddress: z.string().optional(),
      destinationAddress: z.string().optional(),
      destinationPort: z.string().optional(),
      logging: z.boolean().optional(),
    }),
  },
  async ({ siteId, ruleId, ...fields }) => {
    try {
      const payload = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      const data = await unifiRequest("PUT", `/sites/${siteId}/firewall-policies/${ruleId}`, payload);
      return ok(data);
    } catch (e) {
      return err(e);
    }
  }
);

server.registerTool(
  "delete_firewall_rule",
  {
    description: "Delete a firewall policy/rule by its ID.",
    inputSchema: z.object({
      siteId: z.string().default(DEFAULT_SITE_ID).describe("Site ID (from list_sites). Defaults to the first site on the controller."),
      ruleId: z.string().describe("Firewall rule ID (from list_firewall_rules)"),
    }),
  },
  async ({ siteId, ruleId }) => {
    try {
      const data = await unifiRequest("DELETE", `/sites/${siteId}/firewall-policies/${ruleId}`);
      return ok(data);
    } catch (e) {
      return err(e);
    }
  }
);

// ── Port Forwards ─────────────────────────────────────────────────────────────

server.registerTool(
  "list_port_forwarding",
  {
    description: "List all port forwarding rules on a UniFi site.",
    inputSchema: z.object({
      siteId: z.string().default(DEFAULT_SITE_ID).describe("Site ID (from list_sites). Defaults to the first site on the controller."),
    }),
  },
  async ({ siteId }) => {
    try {
      const data = await unifiRequest("GET", `/sites/${siteId}/port-forwards`);
      return ok(data);
    } catch (e) {
      return err(e);
    }
  }
);

server.registerTool(
  "create_port_forward",
  {
    description: "Create a new port forwarding rule.",
    inputSchema: z.object({
      siteId: z.string().default(DEFAULT_SITE_ID).describe("Site ID (from list_sites). Defaults to the first site on the controller."),
      name: z.string().describe("Rule name"),
      dstPort: z.string().describe("WAN destination port or range, e.g. '8080' or '8000:8010'"),
      fwdIp: z.string().describe("LAN IP address to forward to"),
      fwdPort: z.string().describe("LAN destination port, e.g. '80'"),
      protocol: z.enum(["tcp", "udp", "tcp_udp"]).default("tcp_udp").describe("Protocol"),
      enabled: z.boolean().default(true).describe("Enable the rule"),
      srcIp: z.string().default("any").describe("Source IP filter, use 'any' for all"),
    }),
  },
  async ({ siteId, name, dstPort, fwdIp, fwdPort, protocol, enabled, srcIp }) => {
    try {
      const data = await unifiRequest("POST", `/sites/${siteId}/port-forwards`, {
        name, dstPort, fwdIp, fwdPort, protocol, enabled, srcIp,
      });
      return ok(data);
    } catch (e) {
      return err(e);
    }
  }
);

server.registerTool(
  "update_port_forward",
  {
    description: "Update an existing port forwarding rule by its ID.",
    inputSchema: z.object({
      siteId: z.string().default(DEFAULT_SITE_ID).describe("Site ID (from list_sites). Defaults to the first site on the controller."),
      portForwardId: z.string().describe("Port forward ID (from list_port_forwarding)"),
      name: z.string().optional(),
      dstPort: z.string().optional().describe("WAN destination port or range"),
      fwdIp: z.string().optional().describe("LAN IP to forward to"),
      fwdPort: z.string().optional().describe("LAN destination port"),
      protocol: z.enum(["tcp", "udp", "tcp_udp"]).optional(),
      enabled: z.boolean().optional(),
      srcIp: z.string().optional(),
    }),
  },
  async ({ siteId, portForwardId, ...fields }) => {
    try {
      const payload = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
      const data = await unifiRequest("PUT", `/sites/${siteId}/port-forwards/${portForwardId}`, payload);
      return ok(data);
    } catch (e) {
      return err(e);
    }
  }
);

server.registerTool(
  "delete_port_forward",
  {
    description: "Delete a port forwarding rule by its ID.",
    inputSchema: z.object({
      siteId: z.string().default(DEFAULT_SITE_ID).describe("Site ID (from list_sites). Defaults to the first site on the controller."),
      portForwardId: z.string().describe("Port forward ID (from list_port_forwarding)"),
    }),
  },
  async ({ siteId, portForwardId }) => {
    try {
      const data = await unifiRequest("DELETE", `/sites/${siteId}/port-forwards/${portForwardId}`);
      return ok(data);
    } catch (e) {
      return err(e);
    }
  }
);

// ── Firewall Zones ────────────────────────────────────────────────────────────

server.registerTool(
  "list_firewall_groups",
  {
    description: "List all firewall zones on a UniFi site — useful for understanding zone-based firewall topology.",
    inputSchema: z.object({
      siteId: z.string().default(DEFAULT_SITE_ID).describe("Site ID (from list_sites). Defaults to the first site on the controller."),
    }),
  },
  async ({ siteId }) => {
    try {
      const data = await unifiRequest("GET", `/sites/${siteId}/firewall-zones`);
      return ok(data);
    } catch (e) {
      return err(e);
    }
  }
);

// ── Devices ───────────────────────────────────────────────────────────────────

server.registerTool(
  "list_devices",
  {
    description: "List all adopted UniFi devices (APs, switches, gateways) on a site.",
    inputSchema: z.object({
      siteId: z.string().default(DEFAULT_SITE_ID).describe("Site ID (from list_sites). Defaults to the first site on the controller."),
    }),
  },
  async ({ siteId }) => {
    try {
      const data = await unifiRequest("GET", `/sites/${siteId}/devices`);
      return ok(data);
    } catch (e) {
      return err(e);
    }
  }
);

// ── Clients ───────────────────────────────────────────────────────────────────

server.registerTool(
  "list_clients",
  {
    description: "List all connected clients on a UniFi site.",
    inputSchema: z.object({
      siteId: z.string().default(DEFAULT_SITE_ID).describe("Site ID (from list_sites). Defaults to the first site on the controller."),
    }),
  },
  async ({ siteId }) => {
    try {
      const data = await unifiRequest("GET", `/sites/${siteId}/clients`);
      return ok(data);
    } catch (e) {
      return err(e);
    }
  }
);

// ── Bootstrap ─────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("unifi-mcp running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
