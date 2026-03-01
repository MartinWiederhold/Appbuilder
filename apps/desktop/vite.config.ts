import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import type { Plugin } from "vite";

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

export default defineConfig({
  plugins: [react(), serveRunJson()],
});
