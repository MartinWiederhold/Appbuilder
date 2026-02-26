#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function getArg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v ?? fallback;
}

const prompt = getArg("prompt", "");
const project = getArg("project", "demo_project");

function log(line) {
  process.stdout.write(line + "\n");
}
function err(line) {
  process.stderr.write(line + "\n");
}

// repo root = current working dir (tauri sets it to repo root)
const repoRoot = process.cwd();
const projectDir = path.join(repoRoot, "workspace", "projects", project);

log(`[agent] start`);
log(`[agent] project=${project}`);
log(`[agent] prompt=${prompt || "(empty)"}`);
log(`[agent] repoRoot=${repoRoot}`);
log(`[agent] projectDir=${projectDir}`);

fs.mkdirSync(projectDir, { recursive: true });
fs.writeFileSync(
  path.join(projectDir, "agent.txt"),
  `project=${project}\nprompt=${prompt}\ncreated_at=${new Date().toISOString()}\n`,
  "utf8"
);
log(`[agent] wrote ${path.join(projectDir, "agent.txt")}`);

let n = 0;
const timer = setInterval(() => {
  n += 1;
  log(`[agent] tick ${n}: working...`);
  if (n === 2) err(`[agent] (stderr) example warning line`);
  if (n >= 5) {
    clearInterval(timer);
    log(`[agent] done`);
    process.exit(0);
  }
}, 250);

process.on("SIGINT", () => {
  err("[agent] interrupted (SIGINT)");
  process.exit(130);
});
