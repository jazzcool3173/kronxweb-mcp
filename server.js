import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { randomUUID } from "crypto";
import { put, list, del } from "@vercel/blob";

const PORT = process.env.PORT || 3000;

// In-memory deployment index (resets on cold start, URLs are permanent in Blob)
const deployments = [];

// ─── MCP Server ───────────────────────────────────────────
const server = new McpServer({ name: "kronxweb-mcp", version: "1.0.0" });

// ─── Tool 1: deploy_html ──────────────────────────────────
server.tool(
  "deploy_html",
  {
    description: "Deploy an HTML file to Vercel Blob and return a permanent public URL for client review",
    inputSchema: {
      project_name: z.string().describe("Short project name e.g. landing-page-v2"),
      html_content: z.string().describe("Full HTML content to deploy"),
    },
  },
  async ({ project_name, html_content }) => {
    try {
      const safeName = project_name
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .slice(0, 60);

      const id = randomUUID().slice(0, 8);
      const fileName = `previews/${safeName}-${id}.html`;

      // Upload to Vercel Blob (permanent public URL)
      const blob = await put(fileName, html_content, {
        access: "public",
        contentType: "text/html",
        addRandomSuffix: false,
      });

      deployments.push({
        id,
        name: project_name,
        url: blob.url,
        createdAt: new Date().toISOString(),
      });

      return {
        content: [
          {
            type: "text",
            text: `✅ Deployed successfully!\n\nProject : ${project_name}\nURL     : ${blob.url}\n\nShare this URL with your client for review.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `❌ Deploy failed: ${err.message}` }],
      };
    }
  }
);

// ─── Tool 2: list_deployments ─────────────────────────────
server.tool(
  "list_deployments",
  {
    description: "List all deployed HTML previews from Vercel Blob storage",
    inputSchema: {},
  },
  async () => {
    try {
      const { blobs } = await list({ prefix: "previews/" });

      if (blobs.length === 0) {
        return {
          content: [{ type: "text", text: "No deployments yet. Use deploy_html to create your first one." }],
        };
      }

      const listText = blobs
        .map((b, i) => `${i + 1}. ${b.pathname}\n   URL      : ${b.url}\n   Uploaded : ${b.uploadedAt}`)
        .join("\n\n");

      return {
        content: [{ type: "text", text: `📋 All deployments:\n\n${listText}` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `❌ List failed: ${err.message}` }],
      };
    }
  }
);

// ─── Tool 3: delete_deployment ────────────────────────────
server.tool(
  "delete_deployment",
  {
    description: "Delete a deployed HTML preview by its URL",
    inputSchema: {
      url: z.string().describe("The full blob URL to delete"),
    },
  },
  async ({ url }) => {
    try {
      await del(url);
      return {
        content: [{ type: "text", text: `🗑️ Deleted: ${url}` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `❌ Delete failed: ${err.message}` }],
      };
    }
  }
);

// ─── Express App ──────────────────────────────────────────
const app = express();
app.use(express.json({ limit: "10mb" }));

// CORS — allow Claude.ai to connect
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// Session store
const sessions = {};

// ─── MCP Endpoint (Streamable HTTP) ───────────────────────
app.all("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  if (sessionId && sessions[sessionId]) {
    await sessions[sessionId].handleRequest(req, res, req.body);
    return;
  }

  if (req.method === "POST") {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions[id] = transport;
      },
    });

    transport.onclose = () => {
      if (transport.sessionId) delete sessions[transport.sessionId];
    };

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  res.status(400).json({ error: "Bad request" });
});

// ─── Health Check ─────────────────────────────────────────
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    server: "kronxweb-mcp",
    version: "1.0.0",
    storage: "vercel-blob",
    deployments: deployments.length,
  });
});

// ─── Start ────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`kronxweb MCP running on port ${PORT}`);
  console.log(`Health : http://localhost:${PORT}/health`);
  console.log(`MCP    : http://localhost:${PORT}/mcp`);
});