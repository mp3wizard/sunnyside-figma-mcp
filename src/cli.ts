#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { config } from "dotenv";
import { resolve } from "path";
import { getServerConfig } from "./config.js";
import { startHttpServer } from "./server.js";
import { createServer } from "./mcp.js";

// Load .env from the current working directory
config({ path: resolve(process.cwd(), ".env") });

export async function startServer(): Promise<void> {
  // Check if we're running in stdio mode (e.g., via CLI)
  const isStdioMode = process.env.NODE_ENV === "cli" || process.argv.includes("--stdio");

  const config = getServerConfig(isStdioMode);

  // Factory: the MCP SDK forbids connecting one server to multiple transports,
  // so HTTP/SSE mode needs a fresh instance per session (see server.ts).
  const makeServer = () =>
    createServer(config.auth, {
      isHTTP: !isStdioMode,
      outputFormat: config.outputFormat,
    });

  if (isStdioMode) {
    // In STDIO mode, only connect via stdio transport
    console.error(`Initializing Figma MCP Server in STDIO mode...`);

    // Connect STDIO transport for MCP communication
    const transport = new StdioServerTransport();
    await makeServer().connect(transport);
  } else {
    console.log(`Initializing Figma MCP Server in HTTP mode on port ${config.port}...`);
    await startHttpServer(config.port, makeServer, config.bindHost);
  }
}

// If we're being executed directly (not imported), start the server
if (process.argv[1]) {
  startServer().catch((error) => {
    console.error("Failed to start server:", error);
    process.exit(1);
  });
}
