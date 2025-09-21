#!/usr/bin/env node
import express from 'express';
import cors from 'cors';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import axios from 'axios';
import https from 'https';
import fs from 'fs';

// Configuration
const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
const PROXMOX_HOST = process.env.PROXMOX_HOST || 'https://proxmox.volskyi-dmytro.com';
const PROXMOX_TOKEN = process.env.PROXMOX_TOKEN || '';
const SSL_CERT_PATH = process.env.SSL_CERT_PATH || '';
const SSL_KEY_PATH = process.env.SSL_KEY_PATH || '';
const ENABLE_HTTPS = process.env.ENABLE_HTTPS === 'true';

console.log('Starting Proxmox MCP Server...');
console.log(`Port: ${PORT}`);
console.log(`Proxmox Host: ${PROXMOX_HOST}`);

// Create Express app
const app = express();
app.use(cors());
app.use(express.json());

// Proxmox API client
const proxmoxApi = axios.create({
  baseURL: `${PROXMOX_HOST}/api2/json`,
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `PVEAPIToken=${PROXMOX_TOKEN}`
  },
  timeout: 10000
});

// Store active connections
let activeTransport = null;
let mcpServer = null;

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'proxmox-mcp',
    time: new Date().toISOString()
  });
});

// SSE endpoint
app.get('/sse', async (req, res) => {
  console.log('SSE client connected');
  
  // Clean up any existing connection
  if (activeTransport) {
    console.log('Closing existing connection');
    activeTransport = null;
    mcpServer = null;
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('X-Accel-Buffering', 'no');

  // Create MCP server
  mcpServer = new Server(
    { name: 'proxmox-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  // Register tools
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'list_vms',
        description: 'List all VMs and containers',
        inputSchema: {
          type: 'object',
          properties: {
            type: { 
              type: 'string', 
              enum: ['all', 'qemu', 'lxc'],
              description: 'Filter by type'
            }
          }
        }
      },
      {
        name: 'get_node_status',
        description: 'Get node status',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      }
    ]
  }));

  // Handle tool calls
  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    console.log(`Tool call: ${name}`, args);

    try {
      switch (name) {
        case 'list_vms': {
          const resources = [];
          const node = 'pve';
          
          if (!args?.type || args.type === 'all' || args.type === 'lxc') {
            try {
              const response = await proxmoxApi.get(`/nodes/${node}/lxc`);
              resources.push(...response.data.data.map(ct => ({ ...ct, type: 'lxc' })));
            } catch (e) {
              console.error('Error fetching LXC:', e.message);
            }
          }
          
          if (!args?.type || args.type === 'all' || args.type === 'qemu') {
            try {
              const response = await proxmoxApi.get(`/nodes/${node}/qemu`);
              resources.push(...response.data.data.map(vm => ({ ...vm, type: 'qemu' })));
            } catch (e) {
              console.error('Error fetching VMs:', e.message);
            }
          }
          
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(resources, null, 2)
            }]
          };
        }
        
        case 'get_node_status': {
          const response = await proxmoxApi.get('/nodes/pve/status');
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(response.data.data, null, 2)
            }]
          };
        }
        
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      console.error('Tool error:', error);
      throw error;
    }
  });

  // Create transport
  activeTransport = new SSEServerTransport('/message', res);

  // Handle disconnection
  res.on('close', () => {
    console.log('SSE client disconnected');
    activeTransport = null;
    mcpServer = null;
  });

  // Connect MCP server to transport
  try {
    await mcpServer.connect(activeTransport);
    console.log('MCP server connected');
  } catch (error) {
    console.error('MCP connection error:', error);
    res.end();
  }
});

// Message endpoint
app.post('/message', (req, res) => {
  if (!activeTransport) {
    return res.status(404).json({ error: 'No active connection' });
  }
  
  // The transport handles the message
  activeTransport.handleMessage(req, res);
});

// Start server
if (ENABLE_HTTPS && SSL_CERT_PATH && SSL_KEY_PATH) {
  try {
    const httpsOptions = {
      key: fs.readFileSync(SSL_KEY_PATH),
      cert: fs.readFileSync(SSL_CERT_PATH)
    };

    https.createServer(httpsOptions, app).listen(HTTPS_PORT, '0.0.0.0', () => {
      console.log(`HTTPS Server running on https://0.0.0.0:${HTTPS_PORT}`);
      console.log(`Health: https://0.0.0.0:${HTTPS_PORT}/health`);
      console.log(`SSE: https://0.0.0.0:${HTTPS_PORT}/sse`);
    });
  } catch (error) {
    console.error('Failed to start HTTPS server:', error.message);
    console.log('Falling back to HTTP...');

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`HTTP Server running on http://0.0.0.0:${PORT}`);
      console.log(`Health: http://0.0.0.0:${PORT}/health`);
      console.log(`SSE: http://0.0.0.0:${PORT}/sse`);
    });
  }
} else {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`HTTP Server running on http://0.0.0.0:${PORT}`);
    console.log(`Health: http://0.0.0.0:${PORT}/health`);
    console.log(`SSE: http://0.0.0.0:${PORT}/sse`);
  });
}
