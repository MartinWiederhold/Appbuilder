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
const doBuildApk = getArg("build_apk", "0") === "1";

function log(line) { process.stdout.write(line + "\n"); }
function err(line) { process.stderr.write(line + "\n"); }

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

    child.stdout.on("data", (d) => String(d).split(/\r?\n/).forEach((l) => l.length && log(l)));
    child.stderr.on("data", (d) => String(d).split(/\r?\n/).forEach((l) => l.length && err(l)));

    child.on("close", (code) => resolve(code ?? 1));
    child.on("error", (e) => { err(`[spawn_error] ${e}`); resolve(1); });
  });
}

function parseField(prompt, fieldName) {
  const re = new RegExp(`${fieldName}\\s*:\\s*(.+)`, "i");
  const m = prompt.match(re);
  return m && m[1] ? m[1].trim() : null;
}

function fallbackTitle(prompt) {
  const t = prompt.trim().replace(/\s+/g, " ");
  if (!t) return "Flutter Builder App";
  return t.length > 32 ? t.slice(0, 32) + "…" : t;
}

function escapeDartString(s) {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

// Only operate inside the first MaterialApp(...) argument list.
// This avoids duplicating/injecting unrelated `title:` occurrences.
function setMaterialAppTitle(src, title) {
  const idx = src.search(/MaterialApp\s*\(/m);
  if (idx === -1) return { src, changed: false, mode: "no_materialapp" };

  const before = src.slice(0, idx);
  const rest = src.slice(idx);

  // Find matching closing paren for the first MaterialApp(
  let depth = 0;
  let end = -1;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return { src, changed: false, mode: "unbalanced" };

  const block = rest.slice(0, end + 1);
  const after = rest.slice(end + 1);

  // Replace existing title in block
  const reTitle = /(^|\n)(\s*)title\s*:\s*(['"])(.*?)\3\s*,/m;
  if (reTitle.test(block)) {
    const rep = block.replace(reTitle, `$1$2title: "${escapeDartString(title)}",`);
    const out = before + rep + after;
    return { src: out, changed: out !== src, mode: "replaced" };
  }

  // Inject near start of argument list (after MaterialApp()
  const rep = block.replace(/MaterialApp\s*\(\s*/m, `MaterialApp(\n      title: "${escapeDartString(title)}",\n      `);
  const out = before + rep + after;
  return { src: out, changed: out !== src, mode: "injected" };
}

function replaceMyHomePageTitle(src, title) {
  const re = /MyHomePage\s*\(\s*title\s*:\s*(['"])(.*?)\1\s*\)/m;
  if (!re.test(src)) return { src, changed: false, mode: "no_match" };
  const rep = src.replace(re, `MyHomePage(title: "${escapeDartString(title)}")`);
  return { src: rep, changed: rep !== src, mode: "replaced" };
}

function replaceAppBarTitleText(src, title) {
  const reWidget = /title\s*:\s*Text\s*\(\s*widget\.title\s*\)\s*,/m;
  if (reWidget.test(src)) {
    const rep = src.replace(reWidget, `title: Text("${escapeDartString(title)}"),`);
    return { src: rep, changed: rep !== src, mode: "replaced_widget" };
  }
  const reLit = /title\s*:\s*Text\s*\(\s*(['"])(.*?)\1\s*\)\s*,/m;
  if (reLit.test(src)) {
    const rep = src.replace(reLit, `title: Text("${escapeDartString(title)}"),`);
    return { src: rep, changed: rep !== src, mode: "replaced_literal" };
  }
  return { src, changed: false, mode: "no_match" };
}

// One-time cleanup: if we somehow have duplicate `title:` entries inside MaterialApp block, keep the first.
function dedupeMaterialAppTitle(src) {
  const idx = src.search(/MaterialApp\s*\(/m);
  if (idx === -1) return { src, changed: false };
  const before = src.slice(0, idx);
  const rest = src.slice(idx);

  let depth = 0;
  let end = -1;
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i];
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return { src, changed: false };

  const block = rest.slice(0, end + 1);
  const after = rest.slice(end + 1);

  const lines = block.split("\n");
  let seen = 0;
  const outLines = lines.filter((ln) => {
    if (ln.match(/^\s*title\s*:\s*/)) {
      seen += 1;
      return seen === 1;
    }
    return true;
  });

  const rep = outLines.join("\n");
  const out = before + rep + after;
  return { src: out, changed: out !== src };
}

function applyPatches(mainDartPath, prompt) {
  const src0 = fs.readFileSync(mainDartPath, "utf8");

  const materialTitle = parseField(prompt, "title") ?? fallbackTitle(prompt);
  const homeTitle = parseField(prompt, "home_title");
  const appBarTitle = parseField(prompt, "appbar_title");

  let src = src0;
  const changes = [];

  // cleanup first (handles your current duplicate state)
  {
    const r = dedupeMaterialAppTitle(src);
    src = r.src;
    if (r.changed) changes.push({ patch: "dedupe_material_title", mode: "cleanup", changed: true, value: "" });
  }

  {
    const r = setMaterialAppTitle(src, materialTitle);
    src = r.src;
    changes.push({ patch: "material_title", mode: r.mode, changed: r.changed, value: materialTitle });
  }

  if (homeTitle) {
    const r = replaceMyHomePageTitle(src, homeTitle);
    src = r.src;
    changes.push({ patch: "home_title", mode: r.mode, changed: r.changed, value: homeTitle });
  }

  if (appBarTitle) {
    const r = replaceAppBarTitleText(src, appBarTitle);
    src = r.src;
    changes.push({ patch: "appbar_title", mode: r.mode, changed: r.changed, value: appBarTitle });
  }

  if (src !== src0) fs.writeFileSync(mainDartPath, src, "utf8");
  return changes;
}

async function main() {
  const prompt = promptRaw;

  log(`[agent] start`);
  log(`[agent] project=${project}`);
  log(`[agent] prompt=${prompt || "(empty)"}`);
  log(`[agent] repoRoot=${repoRoot}`);
  log(`[agent] projectDir=${projectDir}`);
  log(`[agent] build_apk=${doBuildApk ? "1" : "0"}`);

  fs.mkdirSync(projectDir, { recursive: true });

  fs.writeFileSync(
    path.join(projectDir, "agent.txt"),
    `project=${project}\nprompt=${prompt}\ncreated_at=${new Date().toISOString()}\n`,
    "utf8"
  );

  if (!existsFlutterProject(projectDir)) {
    const safeName = sanitizeProjectName(project);
    log(`[agent] flutter project not found -> creating (${safeName})`);
    const code = await run("flutter", ["create", "--project-name", safeName, "."], projectDir);
    if (code !== 0) { err(`[agent] flutter create failed (exit=${code})`); process.exit(code); }
  } else {
    log(`[agent] flutter project exists`);
  }

  const mainDart = path.join(projectDir, "lib", "main.dart");
  log(`[agent] applying prompt patches to lib/main.dart`);
  const changes = applyPatches(mainDart, prompt);
  changes.forEach((c) => log(`[agent] patch ${c.patch} mode=${c.mode} changed=${c.changed} value="${c.value}"`));

  { const code = await run("flutter", ["pub", "get"], projectDir); if (code !== 0) process.exit(code); }
  { const code = await run("flutter", ["analyze"], projectDir); if (code !== 0) process.exit(code); }
  { const code = await run("flutter", ["test"], projectDir); if (code !== 0) process.exit(code); }

  if (doBuildApk) {
    const code = await run("flutter", ["build", "apk", "--debug"], projectDir);
    if (code !== 0) process.exit(code);
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
