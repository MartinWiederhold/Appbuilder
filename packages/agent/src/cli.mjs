#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

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

const repoRoot = process.cwd();
const projectDir = path.join(repoRoot, "workspace", "projects", project);

function sanitizeProjectName(name) {
  // Flutter package name rules are stricter; we keep folder name as given,
  // but when creating we pass a safe org + project name.
  return name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

function existsFlutterProject(dir) {
  return fs.existsSync(path.join(dir, "pubspec.yaml")) && fs.existsSync(path.join(dir, "lib"));
}

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    log(`$ ${cmd} ${args.join(" ")}`);
    const child = spawn(cmd, args, { cwd, shell: false });

    child.stdout.on("data", (d) => log(String(d).trimEnd()));
    child.stderr.on("data", (d) => err(String(d).trimEnd()));

    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", (e) => {
      err(`[spawn_error] ${e}`);
      resolve(1);
    });
  });
}

async function main() {
  log(`[agent] start`);
  log(`[agent] project=${project}`);
  log(`[agent] prompt=${prompt || "(empty)"}`);
  log(`[agent] repoRoot=${repoRoot}`);
  log(`[agent] projectDir=${projectDir}`);

  fs.mkdirSync(projectDir, { recursive: true });

  // marker file (keeps Phase 1 behavior)
  fs.writeFileSync(
    path.join(projectDir, "agent.txt"),
    `project=${project}\nprompt=${prompt}\ncreated_at=${new Date().toISOString()}\n`,
    "utf8"
  );

  // Ensure Flutter project exists
  if (!existsFlutterProject(projectDir)) {
    const safeName = sanitizeProjectName(project);
    log(`[agent] flutter project not found -> creating (${safeName})`);
    // create inside existing directory
    let code = await run("flutter", ["create", "--project-name", safeName, "."], projectDir);
    if (code !== 0) {
      err(`[agent] flutter create failed (exit=${code})`);
      process.exit(code);
    }
  } else {
    log(`[agent] flutter project exists`);
  }

  // Pub get
  {
    const code = await run("flutter", ["pub", "get"], projectDir);
    if (code !== 0) {
      err(`[agent] flutter pub get failed (exit=${code})`);
      process.exit(code);
    }
  }

  // Analyze
  {
    const code = await run("flutter", ["analyze"], projectDir);
    if (code !== 0) {
      err(`[agent] flutter analyze failed (exit=${code})`);
      process.exit(code);
    }
  }

  log(`[agent] done`);
  process.exit(0);
}

process.on("SIGINT", () => {
  err("[agent] interrupted (SIGINT)");
  process.exit(130);
});

main().catch((e) => {
  err(`[agent] fatal: ${e?.stack || e}`);
  process.exit(1);
});
