import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { randomUUID } from "crypto";
import { put, list, del } from "@vercel/blob";

const PORT = process.env.PORT || 3000;
const BLOB_TOKEN = process.env.KRONXWEB_READ_WRITE_TOKEN;

if (!BLOB_TOKEN) {
  throw new Error(
    "KRONXWEB_READ_WRITE_TOKEN environment variable is missing"
  );
}

const app = express();
app.use(express.json({ limit: "10mb" }));

// Simple request logging
app.use((req, res, next) => {
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`
  );
  next();
});

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, DELETE, OPTIONS"
  );
  res.setHeader("Access-Control-Allow-Headers", "*");

  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }

  next();
});

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

const sessions = new Map();

// Clean old sessions every hour
setInterval(() => {
  const now = Date.now();

  for (const [id, session] of sessions.entries()) {
    const age = now - session.createdAt;

    if (age > 24 * 60 * 60 * 1000) {
      sessions.delete(id);
      console.log(`Removed stale session: ${id}`);
    }
  }
}, 60 * 60 * 1000);

function createServer() {
  const server = new McpServer({
    name: "kronxweb-mcp",
    version: "1.0.0",
  });

  // DEPLOY HTML
  server.tool(
    "deploy_html",
    "Deploy an HTML file and return a public URL",
    {
      project_name: z.string(),
      html_content: z.string(),
    },
    async ({ project_name, html_content }) => {
      try {
        const safeName =
          project_name
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 60) || "preview";

        const id = randomUUID().slice(0, 8);

        const fileName = `previews/${safeName}-${id}.html`;

        const blob = await put(fileName, html_content, {
          access: "public",
          contentType: "text/html",
          addRandomSuffix: false,
          token: BLOB_TOKEN,
        });

        return {
          content: [
            {
              type: "text",
              text:
                `Deployment successful\n\n` +
                `Project: ${project_name}\n` +
                `URL: ${blob.url}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Deploy failed: ${getErrorMessage(error)}`,
            },
          ],
        };
      }
    }
  );

  // LIST DEPLOYMENTS
  server.tool(
    "list_deployments",
    "List all deployments",
    {},
    async () => {
      try {
        const { blobs } = await list({
          prefix: "previews/",
          token: BLOB_TOKEN,
        });

        if (!blobs.length) {
          return {
            content: [
              {
                type: "text",
                text: "No deployments found",
              },
            ],
          };
        }

        blobs.sort(
          (a, b) =>
            new Date(b.uploadedAt).getTime() -
            new Date(a.uploadedAt).getTime()
        );

        const output = blobs
          .map(
            (blob, index) =>
              `${index + 1}. ${blob.pathname}\n` +
              `URL: ${blob.url}\n` +
              `Date: ${blob.uploadedAt}`
          )
          .join("\n\n");

        return {
          content: [
            {
              type: "text",
              text: output,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `List failed: ${getErrorMessage(error)}`,
            },
          ],
        };
      }
    }
  );

  // DELETE DEPLOYMENT
  server.tool(
    "delete_deployment",
    "Delete deployment by URL",
    {
      url: z.string().url(),
    },
    async ({ url }) => {
      try {
        const parsed = new URL(url);

        if (!parsed.pathname.includes("/previews/")) {
          throw new Error(
            "Only preview files can be deleted"
          );
        }

        await del(url, {
          token: BLOB_TOKEN,
        });

        return {
          content: [
            {
              type: "text",
              text: `Deleted: ${url}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Delete failed: ${getErrorMessage(error)}`,
            },
          ],
        };
      }
    }
  );

  return server;
}

app.all("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"];

    if (
      sessionId &&
      typeof sessionId === "string" &&
      sessions.has(sessionId)
    ) {
      const session = sessions.get(sessionId);

      await session.transport.handleRequest(
        req,
        res,
        req.body
      );

      return;
    }

    if (req.method === "POST") {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),

        onsessioninitialized: (id) => {
          sessions.set(id, {
            transport,
            createdAt: Date.now(),
          });

          console.log(`Session created: ${id}`);
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          sessions.delete(transport.sessionId);
          console.log(
            `Session closed: ${transport.sessionId}`
          );
        }
      };

      const server = createServer();

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);

      return;
    }

    return res.status(400).json({
      error: "Bad request",
    });
  } catch (error) {
    console.error(error);

    if (!res.headersSent) {
      return res.status(500).json({
        error: getErrorMessage(error),
      });
    }
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    server: "kronxweb-mcp",
    version: "1.0.0",
    activeSessions: sessions.size,
  });
});

process.on("SIGINT", () => {
  console.log("Shutting down");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Shutting down");
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`kronxweb-mcp running on port ${PORT}`);
});