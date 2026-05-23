import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { Server } from "http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Logger } from "./utils/logger.js";
import { setupPluginIntegration } from "./plugin-integration.js";
import { hostValidationMiddleware, createBearerAuthMiddleware } from "./utils/http-security.js";

let httpServer: Server | null = null;
const transports = {
  streamable: {} as Record<string, StreamableHTTPServerTransport>,
  sse: {} as Record<string, SSEServerTransport>,
};

export async function startHttpServer(
  port: number,
  mcpServer: McpServer,
  bindHost: string = "127.0.0.1",
): Promise<void> {
  const app = express();

  // Do not trust X-Forwarded-* so the Host check below cannot be spoofed.
  app.set("trust proxy", false);

  // Anti-DNS-rebinding: reject any request whose Host header is not loopback.
  // Registered first so it guards every route, including plugin endpoints.
  app.use(hostValidationMiddleware);

  // Optional bearer-token auth for the MCP/SSE endpoints. Enabled only when
  // MCP_AUTH_TOKEN is set. Plugin endpoints rely on loopback bind + Host check
  // since the Figma plugin cannot carry a secret without UI changes.
  const authToken = process.env.MCP_AUTH_TOKEN ?? "";
  const requireAuth = createBearerAuthMiddleware(authToken);

  // Setup plugin integration endpoints
  setupPluginIntegration(app);

  // Parse JSON requests for the Streamable HTTP endpoint only, will break SSE endpoint
  app.use("/mcp", express.json());

  // Modern Streamable HTTP endpoint
  app.post("/mcp", requireAuth, async (req, res) => {
    Logger.log("Received StreamableHTTP request");
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    // Logger.log("Session ID:", sessionId);
    // Logger.log("Headers:", req.headers);
    // Logger.log("Body:", req.body);
    // Logger.log("Is Initialize Request:", isInitializeRequest(req.body));
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports.streamable[sessionId]) {
      // Reuse existing transport
      Logger.log("Reusing existing StreamableHTTP transport for sessionId", sessionId);
      transport = transports.streamable[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
      Logger.log("New initialization request for StreamableHTTP sessionId", sessionId);
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sessionId) => {
          // Store the transport by session ID
          transports.streamable[sessionId] = transport;
        },
      });
      transport.onclose = () => {
        if (transport.sessionId) {
          delete transports.streamable[transport.sessionId];
        }
      };
      // TODO? There semes to be an issue—at least in Cursor—where after a connection is made to an HTTP Streamable endpoint, SSE connections to the same Express server fail with "Received a response for an unknown message ID"
      await mcpServer.connect(transport);
    } else {
      // Invalid request
      Logger.log("Invalid request:", req.body);
      res.status(400).json({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Bad Request: No valid session ID provided",
        },
        id: null,
      });
      return;
    }

    let progressInterval: NodeJS.Timeout | null = null;
    const progressToken = req.body.params?._meta?.progressToken;
    // Logger.log("Progress token:", progressToken);
    let progress = 0;
    if (progressToken) {
      Logger.log(
        `Setting up progress notifications for token ${progressToken} on session ${sessionId}`,
      );
      progressInterval = setInterval(async () => {
        Logger.log("Sending progress notification", progress);
        await mcpServer.server.notification({
          method: "notifications/progress",
          params: {
            progress,
            progressToken,
          },
        });
        progress++;
      }, 1000);
    }

    Logger.log("Handling StreamableHTTP request");
    await transport.handleRequest(req, res, req.body);

    if (progressInterval) {
      clearInterval(progressInterval);
    }
    Logger.log("StreamableHTTP request handled");
  });

  // Handle GET requests for SSE streams (using built-in support from StreamableHTTP)
  const handleSessionRequest = async (req: Request, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports.streamable[sessionId]) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }

    console.error(`Received session termination request for session ${sessionId}`);

    try {
      const transport = transports.streamable[sessionId];
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("Error handling session termination:", error);
      if (!res.headersSent) {
        res.status(500).send("Error processing session termination");
      }
    }
  };

  // Handle GET requests for server-to-client notifications via SSE
  app.get("/mcp", requireAuth, handleSessionRequest);

  // Handle DELETE requests for session termination
  app.delete("/mcp", requireAuth, handleSessionRequest);

  app.get("/sse", requireAuth, async (req, res) => {
    Logger.log("Establishing new SSE connection");
    const transport = new SSEServerTransport("/messages", res);
    Logger.log(`New SSE connection established for sessionId ${transport.sessionId}`);
    Logger.log("/sse request headers:", req.headers);
    Logger.log("/sse request body:", req.body);

    transports.sse[transport.sessionId] = transport;
    res.on("close", () => {
      delete transports.sse[transport.sessionId];
    });

    await mcpServer.connect(transport);
  });

  app.post("/messages", requireAuth, async (req, res) => {
    const sessionId = req.query.sessionId as string;
    const transport = transports.sse[sessionId];
    if (transport) {
      Logger.log(`Received SSE message for sessionId ${sessionId}`);
      Logger.log("/messages request headers:", req.headers);
      Logger.log("/messages request body:", req.body);
      await transport.handlePostMessage(req, res);
    } else {
      res.status(400).send(`No transport found for sessionId ${sessionId}`);
      return;
    }
  });

  httpServer = app.listen(port, bindHost, () => {
    Logger.important(`HTTP server listening on ${bindHost}:${port}`);
    if (!authToken) {
      Logger.important(
        "MCP_AUTH_TOKEN not set — endpoints protected by loopback bind + Host validation only. " +
          "Set MCP_AUTH_TOKEN to require a bearer token on the /mcp and /sse endpoints.",
      );
    }
    Logger.log(`SSE endpoint available at http://${bindHost}:${port}/sse`);
    Logger.log(`Message endpoint available at http://${bindHost}:${port}/messages`);
    Logger.log(`StreamableHTTP endpoint available at http://${bindHost}:${port}/mcp`);
  });

  process.on("SIGINT", async () => {
    Logger.log("Shutting down server...");

    // Close all active transports to properly clean up resources
    await closeTransports(transports.sse);
    await closeTransports(transports.streamable);

    Logger.log("Server shutdown complete");
    process.exit(0);
  });
}

async function closeTransports(
  transports: Record<string, SSEServerTransport | StreamableHTTPServerTransport>,
) {
  for (const sessionId in transports) {
    try {
      await transports[sessionId]?.close();
      delete transports[sessionId];
    } catch (error) {
      console.error(`Error closing transport for session ${sessionId}:`, error);
    }
  }
}

export async function stopHttpServer(): Promise<void> {
  if (!httpServer) {
    throw new Error("HTTP server is not running");
  }

  return new Promise((resolve, reject) => {
    httpServer!.close((err: Error | undefined) => {
      if (err) {
        reject(err);
        return;
      }
      httpServer = null;
      const closing = Object.values(transports.sse).map((transport) => {
        return transport.close();
      });
      Promise.all(closing).then(() => {
        resolve();
      });
    });
  });
}
