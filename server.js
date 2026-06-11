import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { randomUUID } from "crypto";
import fs from "fs";
import path from "path";

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const PREVIEWS_DIR = "./previews";

if (!fs.existsSync(PREVIEWS_DIR)) {
  fs.mkdirSync(PREVIEWS_DIR, { recursive: true });
}

const deployments = [];

const server = new McpServer({ name: "kronxweb-mcp", version: "1.0.0" });

server.tool(
  "deploy_html",
  {
    description: "Deploy HTML and get a shareable URL for client review",
    inputSchema: {
      project_name: z.string().describe("Project name e.g. landing-page-v2"),
      html_content: z.string().describe("Full HTML content to deploy"),
    },
  },
  async ({ project_name, html_content }) => {
    try {
      const safeName = project_name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 60);
      const id = randomUUID().slice(0, 8);
      const fileName = `${safeName}-${id}.html`;
      const filePath = path.join(PREVIEWS_DIR, fileName);
      fs.writeFileSync(filePath, html_content, "utf8");
      const publicUrl = `${BASE_URL}/previews/${fileName}`;
      deployments.push({ id, name: project_name, fileName, url: publicUrl, createdAt: new Date().toISOString() });
      return { content: [{ type: "text", text: `✅ Deployed!\n\nProject : ${project_name}\nURL     : ${publicUrl}\n\nShare this URL with your client.` }] };
    } catch (err) {
      return { content: [{ type: "text", text: `❌ Deploy failed: ${err.message}` }] };
    }
  }
);

server.tool(
  "list_deployments",
  { description: "List all deployed HTML previews", inputSchema: {} },
  async () => {
    if (deployments.length === 0) return { content: [{ type: "text", text: "No deployments yet." }] };
    const list = deployments.map((d, i) => `${i + 1}. ${d.name}\n   URL : ${d.url}\n   Date: ${d.createdAt}`).join("\n\n");
    return { content: [{ type: "text", text: `📋 Deployments:\n\n${list}` }] };
  }
);

server.tool(
  "delete_deployment",
  { description: "Delete a deployed preview", inputSchema: { project_name: z.string() } },
  async ({ project_name }) => {
    const index = deployments.findIndex((d) => d.name === project_name || d.id === project_name);
    if (index === -1) return { content: [{ type: "text", text: `❌ Not found: ${project_name}` }] };
    const dep = deployments[index];
    const filePath = path.join(PREVIEWS_DIR, dep.fileName);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    deployments.splice(index, 1);
    return { content: [{ type: "text", text: `🗑️ Deleted: ${dep.name}` }] };
  }
);

const app = express();
app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

app.use("/previews", express.static(PREVIEWS_DIR));

const sessions = {};

app.all("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"];

  if (sessionId && sessions[sessionId]) {
    await sessions[sessionId].handleRequest(req, res, req.body);
    return;
  }

  if (req.method === "POST") {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => { sessions[id] = transport; },
    });
    transport.onclose = () => { if (transport.sessionId) delete sessions[transport.sessionId]; };
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    return;
  }

  res.status(400).json({ error: "Bad request" });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", server: "kronxweb-mcp", version: "1.0.0", deployments: deployments.length });
});

app.listen(PORT, () => {
  console.log(`kronxweb MCP running → ${BASE_URL}/mcp`);
  console.log(`Health check         → ${BASE_URL}/health`);
});