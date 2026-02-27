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

const promptRaw = getArg("prompt", "");
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
  return name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
}

function existsFlutterProject(dir) {
  return fs.existsSync(path.join(dir, "pubspec.yaml")) && fs.existsSync(path.join(dir, "lib", "main.dart"));
}

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    log(`$ ${cmd} ${args.join(" ")}`);
    const child = spawn(cmd, args, { cwd, shell: false });

    child.stdout.on("data", (d) => {
      const s = String(d);
      // keep multiline chunks readable
      s.split(/\r?\n/).forEach((line) => line.length && log(line));
    });
    child.stderr.on("data", (d) => {
      const s = String(d);
      s.split(/\r?\n/).forEach((line) => line.length && err(line));
    });

    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", (e) => {
      err(`[spawn_error] ${e}`);
      resolve(1);
    });
  });
}

function parseTitleFromPrompt(prompt) {
  const m = prompt.match(/title\s*:\s*(.+)/i);
  if (m && m[1]) return m[1].trim();
  // fallback: use prompt as title, clipped
  const t = prompt.trim().replace(/\s+/g, " ");
  if (!t) return "Flutter Builder App";
  return t.length > 32 ? t.slice(0, 32) + "…" : t;
}

function escapeDartString(s) {
  // simplest safe for double-quoted dart string
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function patchMainDartTitle(mainDartPath, newTitle) {
  const src = fs.readFileSync(mainDartPath, "utf8");

  // Replace: title: 'X' OR title: "X"
  const replaced = src.replace(
    /title\s*:\s*(['"])(.*?)\1\s*,/m,
    `title: "${escapeDartString(newTitle)}",`
  );

  if (replaced === src) {
    // If no title found, inject into MaterialApp(...)
    const injected = src.replace(
      /MaterialApp\s*\(/m,
      `MaterialApp(\n      title: "${escapeDartString(newTitle)}",`
    );
    if (injected === src) return { changed: false, mode: "no_match" };
    fs.writeFileSync(mainDartPath, injected, "utf8");
    return { changed: true, mode: "injected" };
  }

  fs.writeFileSync(mainDartPath, replaced, "utf8");
  return { changed: true, mode: "replaced" };
}

async function main() {
  const prompt = promptRaw;
  log(`[agent] start`);
  log(`[agent] project=${project}`);
  log(`[agent] prompt=${prompt || "(empty)"}`);
  log(`[agent] repoRoot=${repoRoot}`);
  log(`[agent] projectDir=${projectDir}`);

  fs.mkdirSync(projectDir, { recursive: true });

  // marker file
  fs.writeFileSync(
    path.join(projectDir, "agent.txt"),
    `project=${project}\nprompt=${prompt}\ncreated_at=${new Date().toISOString()}\n`,
    "utf8"
  );

  // Ensure Flutter project exists
  if (!existsFlutterProject(projectDir)) {
    const safeName = sanitizeProjectName(project);
    log(`[agent] flutter project not found -> creating (${safeName})`);
    const code = await run("flutter", ["create", "--project-name", safeName, "."], projectDir);
    if (code !== 0) {
      err(`[agent] flutter create failed (exit=${code})`);
      process.exit(code);
    }
  } else {
    log(`[agent] flutter project exists`);
  }

  // Apply prompt → code change (title)
  const mainDart = path.join(projectDir, "lib", "main.dart");
  const newTitle = parseTitleFromPrompt(prompt);
  log(`[agent] applying title="${newTitle}" to lib/main.dart`);
  const patch = patchMainDartTitle(mainDart, newTitle);
  log(`[agent] patch_main_dart mode=${patch.mode} changed=${patch.changed}`);

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
