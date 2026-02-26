#!/usr/bin/env node
import { execa } from "execa";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function log(line) {
  process.stdout.write(line + "\n");
}

function sanitizeProjectName(name) {
  let n = (name || "").trim().toLowerCase();
  n = n.replace(/[^a-z0-9_]/g, "_");
  n = n.replace(/_+/g, "_");
  n = n.replace(/^_+/, "");
  if (!n) n = "my_app";
  if (!/^[a-z]/.test(n)) n = "app_" + n;
  return n;
}

async function run() {
  const args = process.argv.slice(2);
  const rawName = args[0] || "";
  const prompt = args.slice(1).join(" ") || "";

  if (!rawName.trim()) {
    log("Agent error: Missing project name.");
    log('Usage: node index.js "<project_name>" "<prompt...>"');
    process.exit(2);
  }

  const projectName = sanitizeProjectName(rawName);

  // ✅ Repo-Root stabil aus Script-Pfad bestimmen (nicht aus current working dir)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const repoRoot = path.resolve(__dirname, "..", "..");

  const projectsRoot = path.join(repoRoot, "workspace", "projects");
  const projectDir = path.join(projectsRoot, projectName);

  log("Agent: starting...");
  log("Agent: projectName=" + projectName);
  log("Agent: workspace=" + projectDir);
  if (prompt.trim()) log("Agent: prompt=" + prompt.trim());

  fs.mkdirSync(projectsRoot, { recursive: true });

  if (fs.existsSync(projectDir)) {
    log("Agent error: Project folder already exists: " + projectDir);
    process.exit(3);
  }

  log("Agent: flutter create …");
  const c = await execa("flutter", ["create", projectName], { cwd: projectsRoot });
  if (c.stdout) log(c.stdout.trim());
  if (c.stderr) log(c.stderr.trim());

  log("Agent: flutter analyze …");
  const a = await execa("flutter", ["analyze"], { cwd: projectDir });
  if (a.stdout) log(a.stdout.trim());
  if (a.stderr) log(a.stderr.trim());

  log("Agent: done.");
}

run().catch((e) => {
  log("Agent failed:");
  log(String(e));
  process.exit(1);
});
