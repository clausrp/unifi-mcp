# UniFi MCP Server

A Model Context Protocol (MCP) server providing network management and configuration tools for Ubiquiti UniFi gateways and controllers (both local controllers and UniFi Cloud API).

## Features

Enables LLMs and MCP clients (such as Claude Desktop, Bob, etc.) to query and configure UniFi networks:

- **Sites & Devices**: List sites, adopted UniFi hardware (gateways, switches, APs), and active clients.
- **Networks & VLANs**: List, create, update, and delete corporate, guest, VLAN-only, and WAN networks with DHCP configuration.
- **Firewall Rules & Zones**: Inspect, create, edit, and delete firewall policy rules and view firewall groups/zones.
- **Port Forwarding**: List, create, modify, and delete port forwarding rules.

## Installation & Setup

### 1. Install Dependencies & Build
```bash
npm install
npm run build
```

### 2. Configure Environment Variables
Copy `.env.example` to `.env` or pass the environment variables in your MCP client config:

```bash
# Local UniFi Gateway / Cloud Key:
UNIFI_HOST=https://192.168.1.1
UNIFI_API_KEY=your-local-api-key

# Or UniFi Cloud (api.ui.com):
# UNIFI_HOST=https://api.ui.com
# UNIFI_API_KEY=your-cloud-api-key
```

### 3. Register with MCP Client

Example configuration in `mcp_config.json` / Claude Desktop:

```json
{
  "mcpServers": {
    "unifi": {
      "command": "node",
      "args": ["/path/to/unifi-mcp/build/index.js"],
      "env": {
        "UNIFI_HOST": "https://192.168.1.1",
        "UNIFI_API_KEY": "your-api-key"
      }
    }
  }
}
```
