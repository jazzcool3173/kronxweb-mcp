import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const app = createMcpExpressApp();
const server = new McpServer({ name: "kronxweb", version: "1.0.0" });
const transports = {};

app.get("/", (req, res) => {
  res.status(200).json({
    name: "kronxweb",
    status: "running",
    endpoints: {
      health: "/health",
      mcp: "/mcp",
      sse: "/sse",
      messages: "/messages"
    }
  });
});

// Tool 1: Deploy HTML
server.tool("deploy_html",
  { html_content: z.string(), project_name: z.string() },
  async ({ html_content, project_name }) => {
    // Save file + return public URL
    // Your hosting logic here
    const url = `https://kronxweb.com/previews/${project_name}`;
    return { content: [{ type: "text", text: `Live at: ${url}` }] };
  }
);

// Tool 2: List deployments
server.tool("list_deployments",
  {},
  async () => {
    return { content: [{ type: "text", text: "Your deployments here" }] };
  }
);

app.get("/health", (req, res) => {
  res.status(200).json({ ok: true, name: "kronxweb", version: "1.0.0" });
});

// SSE endpoint for Claude
async function handleSseConnection(req, res) {
  try {
    const transport = new SSEServerTransport("/messages", res);
    const { sessionId } = transport;

    transports[sessionId] = transport;
    transport.onclose = () => {
      delete transports[sessionId];
    };

    await server.connect(transport);
  } catch (error) {
    console.error("Error establishing SSE stream:", error);
    if (!res.headersSent) {
      res.status(500).send("Error establishing SSE stream");
    }
  }
}

app.get("/mcp", handleSseConnection);
app.get("/sse", handleSseConnection);

app.post("/messages", async (req, res) => {
  const { sessionId } = req.query;
  if (!sessionId || typeof sessionId !== "string") {
    res.status(400).send("Missing sessionId parameter");
    return;
  }

  const transport = transports[sessionId];
  if (!transport) {
    res.status(404).send("Session not found");
    return;
  }

  try {
    await transport.handlePostMessage(req, res, req.body);
  } catch (error) {
    console.error("Error handling MCP message:", error);
    if (!res.headersSent) {
      res.status(500).send("Error handling MCP message");
    }
  }
});

const isMain = process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const port = process.env.PORT || 3000;
  const host = process.env.HOST || "127.0.0.1";
  app.listen(port, host, (error) => {
    if (error) {
      console.error("Failed to start Kronxweb MCP server:", error);
      process.exitCode = 1;
      return;
    }

    console.log(`Kronxweb MCP server listening at http://${host}:${port}`);
  });
}

export default app;
