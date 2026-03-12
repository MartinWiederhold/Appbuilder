import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

const repoRoot = path.resolve(process.cwd(), "..", "..");

function serveRunJson(): Plugin {
  return {
    name: "serve-run-json",
    configureServer(server) {
      server.middlewares.use("/agent/run.json", (_req, res) => {
        const p = path.resolve(
          process.cwd(),
          "..",
          "..",
          "workspace",
          "projects",
          "todo_flutter",
          "run.json"
        );
        try {
          const txt = fs.readFileSync(p, "utf8");
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json");
          res.end(txt);
        } catch {
          res.statusCode = 404;
          res.setHeader("Content-Type", "application/json");
          res.end("{}");
        }
      });
    },
  };
}

function serveE2EFiles(): Plugin {
  return {
    name: "serve-e2e-files",
    configureServer(server) {
      server.middlewares.use("/__e2e__/file", (req, res) => {
        const url = new URL(req.url || "", "http://localhost");
        const rel = url.searchParams.get("path");
        if (!rel) {
          res.statusCode = 400;
          res.end("missing path");
          return;
        }

        const full = path.join(repoRoot, rel.replace(/^\/+/, ""));
        if (!fs.existsSync(full)) {
          res.statusCode = 404;
          res.end("not found");
          return;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end(fs.readFileSync(full, "utf-8"));
      });

      server.middlewares.use("/__e2e__/text", (req, res) => {
        const url = new URL(req.url || "", "http://localhost");
        const rel = url.searchParams.get("path");
        if (!rel) {
          res.statusCode = 400;
          res.end("missing path");
          return;
        }

        const full = path.join(
          repoRoot,
          "workspace",
          "projects",
          "todo_flutter",
          rel.replace(/^\/+/, "")
        );

        if (!fs.existsSync(full)) {
          res.statusCode = 404;
          res.end("");
          return;
        }

        res.statusCode = 200;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(fs.readFileSync(full, "utf-8"));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), serveRunJson(), serveE2EFiles()],
});
