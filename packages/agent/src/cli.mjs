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

// MaterialApp-scoped operations + dedupe
function setMaterialAppTitle(src, title) {
  const idx = src.search(/MaterialApp\s*\(/m);
  if (idx === -1) return { src, changed: false, mode: "no_materialapp" };

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
  if (end === -1) return { src, changed: false, mode: "unbalanced" };

  const block = rest.slice(0, end + 1);
  const after = rest.slice(end + 1);

  const reTitle = /(^|\n)(\s*)title\s*:\s*(['"])(.*?)\3\s*,/m;
  if (reTitle.test(block)) {
    const rep = block.replace(reTitle, `$1$2title: "${escapeDartString(title)}",`);
    const out = before + rep + after;
    return { src: out, changed: out !== src, mode: "replaced" };
  }

  const rep = block.replace(/MaterialApp\s*\(\s*/m, `MaterialApp(\n      title: "${escapeDartString(title)}",\n      `);
  const out = before + rep + after;
  return { src: out, changed: out !== src, mode: "injected" };
}

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

function applyPatches(mainDartPath, prompt) {
  const src0 = fs.readFileSync(mainDartPath, "utf8");

  const materialTitle = parseField(prompt, "title") ?? fallbackTitle(prompt);
  const homeTitle = parseField(prompt, "home_title");
  const appBarTitle = parseField(prompt, "appbar_title");

  let src = src0;
  const changes = [];

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

// like run(), but also captures combined output for parsing
function runCapture(cmd, args, cwd) {
  return new Promise((resolve) => {
    log(`$ ${cmd} ${args.join(" ")}`);
    const child = spawn(cmd, args, { cwd, shell: false });

    let out = "";
    const onChunk = (d, isErr) => {
      const s = String(d);
      out += s;
      s.split(/\r?\n/).forEach((l) => l.length && (isErr ? err(l) : log(l)));
    };

    child.stdout.on("data", (d) => onChunk(d, false));
    child.stderr.on("data", (d) => onChunk(d, true));

    child.on("close", (code) => resolve({ code: code ?? 1, output: out }));
    child.on("error", (e) => {
      err(`[spawn_error] ${e}`);
      resolve({ code: 1, output: out + `\n[spawn_error] ${e}\n` });
    });
  });
}

function writeRunJson(payload) {
  fs.writeFileSync(path.join(projectDir, "run.json"), JSON.stringify(payload, null, 2), "utf8");
}

function apkPath(dir) {
  return path.join(dir, "build", "app", "outputs", "flutter-apk", "app-debug.apk");
}

async function main() {
  const prompt = promptRaw;
  const startedAt = new Date().toISOString();
  const steps = [];
  let finalExit = 0;

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

  try {
    if (!existsFlutterProject(projectDir)) {
      const safeName = sanitizeProjectName(project);
      log(`[agent] flutter project not found -> creating (${safeName})`);
      const code = await run("flutter", ["create", "--project-name", safeName, "."], projectDir);
      steps.push({ name: "flutter_create", exitCode: code });
      if (code !== 0) { finalExit = code; throw new Error("flutter_create_failed"); }
    } else {
      log(`[agent] flutter project exists`);
    }

    const mainDart = path.join(projectDir, "lib", "main.dart");
    log(`[agent] applying prompt patches to lib/main.dart`);
    const changes = applyPatches(mainDart, prompt);
    changes.forEach((c) => log(`[agent] patch ${c.patch} mode=${c.mode} changed=${c.changed} value="${c.value}"`));

    {
      const code = await run("flutter", ["pub", "get"], projectDir);
      steps.push({ name: "flutter_pub_get", exitCode: code });
      if (code !== 0) { finalExit = code; throw new Error("flutter_pub_get_failed"); }
    }

    {
      const code = await run("flutter", ["analyze"], projectDir);
      steps.push({ name: "flutter_analyze", exitCode: code });
      if (code !== 0) { finalExit = code; throw new Error("flutter_analyze_failed"); }
    }

    {
      const code = await run("flutter", ["test"], projectDir);
      steps.push({ name: "flutter_test", exitCode: code });
      if (code !== 0) { finalExit = code; throw new Error("flutter_test_failed"); }
    }

    if (doBuildApk) {
      // Toolchain check (doctor output is informative; doctor exit code isn't always reliable)
      log(`[agent] checking android toolchain via flutter doctor -v`);
      const doc = await runCapture("flutter", ["doctor", "-v"], projectDir);
      steps.push({ name: "flutter_doctor_v", exitCode: doc.code });

      // If doctor explicitly shows Android toolchain as ✗, stop early with a clear hint.
      // Typical line: "[✗] Android toolchain - develop for Android devices ..."
      const androidBroken = /\[\s*✗\s*\]\s*Android toolchain/i.test(doc.output);
      if (androidBroken) {
        finalExit = 1;
        err("[agent] Android toolchain is not ready. Fix Flutter doctor issues, then retry with Build APK.");
        err("[agent] Hint: open terminal and run: flutter doctor -v");
        throw new Error("android_toolchain_not_ready");
      }

      log(`[agent] building APK (debug)`);
      const code = await run("flutter", ["build", "apk", "--debug"], projectDir);
      steps.push({ name: "flutter_build_apk_debug", exitCode: code });
      if (code !== 0) { finalExit = code; throw new Error("flutter_build_apk_failed"); }

      const apk = apkPath(projectDir);
      if (fs.existsSync(apk)) {
        log(`[agent] apk_ready=${apk}`);
      } else {
        err(`[agent] build reported success but apk not found at ${apk}`);
      }
    }

    log(`[agent] done`);
    finalExit = 0;
  } catch (e) {
    if (finalExit === 0) finalExit = 1;
    err(`[agent] failed: ${e?.message || e}`);
  } finally {
    const finishedAt = new Date().toISOString();
    const status = finalExit === 0 ? "success" : "failed";
    writeRunJson({
      project,
      status,
      exitCode: finalExit,
      startedAt,
      finishedAt,
      buildApk: doBuildApk,
      steps
    });
    log(`[agent] wrote run.json status=${status} exitCode=${finalExit}`);
  }

  process.exit(finalExit);
}

process.on("SIGINT", () => {
  err("[agent] interrupted (SIGINT)");
  try {
    const now = new Date().toISOString();
    writeRunJson({
      project,
      status: "failed",
      exitCode: 130,
      startedAt: now,
      finishedAt: now,
      buildApk: doBuildApk,
      steps: [{ name: "sigint", exitCode: 130 }]
    });
  } catch {}
  process.exit(130);
});

main().catch((e) => {
  err(`[agent] fatal: ${e?.stack || e}`);
  process.exit(1);
});
