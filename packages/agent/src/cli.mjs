#!/usr/bin/env node
import { getProviderClient } from "./providers/index.mjs";
import { setSecret, getSecret, deleteSecret, listSecretNames } from "./security/secrets.mjs";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

globalThis.__filesChanged = false;

const argv = process.argv.slice(2);

async function maybeHandleSecretsCli() {
  let cmd = "";
  let name = "";
  let value = "";

  if (argv[0] === "secrets") {
    cmd = argv[1] ?? "";
    name = argv[2] ?? "";
    value = argv[3] ?? "";
  } else if (typeof argv[0] === "string" && argv[0].startsWith("secrets:")) {
    cmd = argv[0].slice("secrets:".length);
    name = argv[1] ?? "";
    value = argv[2] ?? "";
  } else {
    return false;
  }

  if (cmd === "set") {
    if (!name || !value) {
      console.error("Usage: node packages/agent/src/cli.mjs secrets set NAME VALUE");
      process.exit(1);
    }
    await setSecret(name, value);
    console.log(`[secrets] stored ${name}`);
    return true;
  }

  if (cmd === "get") {
    if (!name) {
      console.error("Usage: node packages/agent/src/cli.mjs secrets get NAME");
      process.exit(1);
    }
    const v = await getSecret(name);
    console.log(v ? `[secrets] found ${name}` : `[secrets] missing ${name}`);
    return true;
  }

  if (cmd === "list") {
    const names = await listSecretNames();
    if (!names.length) {
      console.log("[secrets] empty");
    } else {
      for (const n of names) console.log(n);
    }
    return true;
  }

  if (cmd === "delete") {
    if (!name) {
      console.error("Usage: node packages/agent/src/cli.mjs secrets delete NAME");
      process.exit(1);
    }
    await deleteSecret(name);
    console.log(`[secrets] deleted ${name}`);
    return true;
  }

  console.error("Usage: node packages/agent/src/cli.mjs secrets <set|get|list|delete> ...");
  process.exit(1);
}

if (await maybeHandleSecretsCli()) {
  process.exit(0);
}



function getArg(name, fallback = "") {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = process.argv[i + 1];
  return v ?? fallback;
}

const promptRaw = getArg("prompt", "");
const project = getArg("project", "demo_project");
const doBuildApk = getArg("build_apk", "0") === "1";
const provider = getArg("provider", "openai");
const mode = getArg("mode", "full");
const stopAfter = getArg("stop_after", "none");

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

// ---------- MaterialApp title patch (scoped) + dedupe ----------
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
    globalThis.__filesChanged = true;
  return true;
  });

  const rep = outLines.join("\n");
  const out = before + rep + after;
  return { src: out, changed: out !== src };
}

// ---------- runners ----------
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

// ---------- run.json ----------
function writeRunJson(payload) {
  fs.writeFileSync(path.join(projectDir, "run.json"), JSON.stringify(payload, null, 2), "utf8");


  // ---- BMAD 4.0.7: trigger flutter hot reload AFTER success ----
  try {
    spawnSync("bash", ["scripts/flutter_hot_reload.sh"], { stdio: "ignore" });
  } catch {}
  }

function apkPath(dir) {
  return path.join(dir, "build", "app", "outputs", "flutter-apk", "app-debug.apk");
}

// ---------- file helpers ----------
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function writeFileIfChanged(filePath, content) {
  const prev = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  if (prev === content) return false;
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf8");
  return true;
}

// ---------- pubspec patch (shared_preferences) ----------
function ensureSharedPrefs(pubspecPath) {
  const src0 = fs.readFileSync(pubspecPath, "utf8");

  // already present?
  if (/^\s*shared_preferences\s*:\s*/m.test(src0)) {
    return { changed: false, mode: "already" };
  }

  // Insert under dependencies:
  const lines = src0.split("\n");
  const out = [];
  let inserted = false;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    out.push(ln);
    if (!inserted && /^dependencies\s*:\s*$/.test(ln.trim())) {
      // next lines are deps indentation; use two spaces (Flutter default)
      out.push("  shared_preferences: ^2.3.2");
      inserted = true;
    }
  }

  if (!inserted) {
    // fallback: append dependencies block
    out.push("");
    out.push("dependencies:");
    out.push("  shared_preferences: ^2.3.2");
    inserted = true;
  }

  const src = out.join("\n");
  if (src !== src0) fs.writeFileSync(pubspecPath, src, "utf8");
  return { changed: src !== src0, mode: "inserted" };
}

// ---------- feature detection ----------
function detectFeature(prompt) {
  const f = parseField(prompt, "feature");
  if (f) return f.trim().toLowerCase();
  if (/\btodo_v1\b/i.test(prompt)) return "todo_v1";
  if (/\btodo\b/i.test(prompt)) return "todo";
  return null;
}

// ---------- generators ----------
function genMain(appTitle, homeTitle) {
  return `import 'package:flutter/material.dart';
import 'features/todo/todo_screen.dart';

void main() {
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      title: "${escapeDartString(appTitle)}",
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.deepPurple),
        useMaterial3: true,
      ),
      home: const TodoScreen(title: "${escapeDartString(homeTitle)}"),
    );
  }
}
`;
}

function genTodoRepository() {
  return `import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

class TodoItem {
  TodoItem({required this.text, this.done = false});

  final String text;
  final bool done;

  TodoItem copyWith({String? text, bool? done}) => TodoItem(
        text: text ?? this.text,
        done: done ?? this.done,
      );

  Map<String, dynamic> toJson() => <String, dynamic>{
        'text': text,
        'done': done,
      };

  static TodoItem fromJson(Map<String, dynamic> json) => TodoItem(
        text: (json['text'] as String?) ?? '',
        done: (json['done'] as bool?) ?? false,
      );
}

class TodoRepository {
  static const String _kKey = 'todos_v1';

  Future<List<TodoItem>> load() async {
    final prefs = await SharedPreferences.getInstance();
    final raw = prefs.getString(_kKey);
    if (raw == null || raw.isEmpty) {
    return <TodoItem>[
      TodoItem(text: 'Erste Aufgabe'),
      TodoItem(text: 'Zweite Aufgabe'),
    ];
  }
    final list = (jsonDecode(raw) as List<dynamic>).cast<Map<String, dynamic>>();
    return list.map(TodoItem.fromJson).toList(growable: true);
  }

  Future<void> save(List<TodoItem> items) async {
    final prefs = await SharedPreferences.getInstance();
    final raw = jsonEncode(items.map((e) => e.toJson()).toList());
    await prefs.setString(_kKey, raw);
  }
}
`;
}

function genTodoScreenV1() {
  return `import 'package:flutter/material.dart';
import 'todo_repository.dart';

class TodoScreen extends StatefulWidget {
  const TodoScreen({super.key, required this.title});
  final String title;

  @override
  State<TodoScreen> createState() => _TodoScreenState();
}

class _TodoScreenState extends State<TodoScreen> {
  final TodoRepository _repo = TodoRepository();
  List<TodoItem> _items = <TodoItem>[];
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final items = await _repo.load();
    if (!mounted) return;
    setState(() {
      _items = items;
      _loading = false;
    });
  }

  Future<void> _persist() async {
    await _repo.save(_items);
  }

  Future<void> _addTodo() async {
    final controller = TextEditingController();
    final result = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Neue Aufgabe'),
        content: TextField(
          controller: controller,
          autofocus: true,
          decoration: const InputDecoration(hintText: 'z.B. Milch kaufen'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(context), child: const Text('Abbrechen')),
          FilledButton(
            onPressed: () => Navigator.pop(context, controller.text.trim()),
            child: const Text('Hinzufügen'),
          ),
        ],
      ),
    );
    if (result == null || result.isEmpty) return;

    setState(() => _items = <TodoItem>[TodoItem(text: result), ..._items]);
    await _persist();
  }

  Future<void> _toggle(int index) async {
    final item = _items[index];
    setState(() {
      final next = item.copyWith(done: !item.done);
      _items = List<TodoItem>.of(_items);
      _items[index] = next;
    });
    await _persist();
  }

  Future<void> _remove(int index) async {
    setState(() {
      _items = List<TodoItem>.of(_items)..removeAt(index);
    });
    await _persist();
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      floatingActionButton: FloatingActionButton(
        onPressed: _addTodo,
        child: const Icon(Icons.add),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : ListView.separated(
              padding: const EdgeInsets.all(12),
              itemCount: _items.length,
              separatorBuilder: (_, _) => const SizedBox(height: 8),
              itemBuilder: (context, i) {
                final item = _items[i];
                return Dismissible(
                  key: ValueKey(item.text + i.toString()),
                  direction: DismissDirection.endToStart,
                  background: Container(
                    alignment: Alignment.centerRight,
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    color: Colors.red.withValues(alpha: 0.8),
                    child: const Icon(Icons.delete, color: Colors.white),
                  ),
                  onDismissed: (_) => _remove(i),
                  child: Material(
                    color: Theme.of(context).colorScheme.surface,
                    borderRadius: BorderRadius.circular(14),
                    child: InkWell(
                      borderRadius: BorderRadius.circular(14),
                      onTap: () => _toggle(i),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
                        child: Row(
                          children: [
                            Icon(item.done ? Icons.check_circle : Icons.radio_button_unchecked),
                            const SizedBox(width: 10),
                            Expanded(
                              child: Text(
                                item.text,
                                style: TextStyle(
                                  fontSize: 16,
                                  decoration: item.done ? TextDecoration.lineThrough : TextDecoration.none,
                                ),
                              ),
                            ),
                            const SizedBox(width: 10),
                            IconButton(
                              tooltip: 'Löschen',
                              onPressed: () => _remove(i),
                              icon: const Icon(Icons.close),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                );
              },
            ),
    );
  }
}
`;
}

function genWidgetTest(projectName, homeTitle) {
  return `import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:${projectName}/main.dart';

void main() {
  testWidgets('Todo app boots', (WidgetTester tester) async {
    await tester.pumpWidget(const MyApp());
    await tester.pump();
    // allow async load (SharedPreferences) + first frame
    await tester.pump(const Duration(seconds: 1));

    expect(find.text('${escapeDartString(homeTitle)}'), findsOneWidget);
    expect(find.byType(FloatingActionButton), findsOneWidget);
  });
}
`;
}

// ---------- main ----------
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
log(`[agent] provider=${provider}`);
log(`[agent] mode=${mode}`);
log(`[agent] stop_after=${stopAfter}`);

try {
  const providerInfo = await getProviderClient(provider);
  log(`[agent] provider_ready=${providerInfo.provider}`);
} catch (e) {
  err(`[agent] provider_error=${e.message}`);
  process.exit(1);
}
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

    const appTitle = parseField(prompt, "title") ?? fallbackTitle(prompt);
    const homeTitle = parseField(prompt, "home_title") ?? "Todo Home";

    // keep MaterialApp title aligned (safe even if main.dart later overwritten)
    const mainDartPath = path.join(projectDir, "lib", "main.dart");
    if (fs.existsSync(mainDartPath)) {
      const src0 = fs.readFileSync(mainDartPath, "utf8");
      let src = src0;
      const d = dedupeMaterialAppTitle(src);
      src = d.src;
      const t = setMaterialAppTitle(src, appTitle);
      src = t.src;
      if (src !== src0) fs.writeFileSync(mainDartPath, src, "utf8");
      log(`[agent] material_title mode=${t.mode} changed=${t.changed} value="${appTitle}"`);
    }

    const feature = detectFeature(prompt);
    if (feature === "todo_v1") {
      log(`[agent] feature=todo_v1 -> generating files + shared_preferences`);

    } else if (feature === "builder_ui_v1") {
      log(`[agent] feature=builder_ui_v1 -> patching builder_ui markers`);

      // Very small, safe patcher: only touches lib/main.dart between AGENT_LOGS markers.
      const mainPath = path.join(projectDir, "lib", "main.dart");
      let main = fs.readFileSync(mainPath, "utf8");

      const m = main.match(/AGENT_LOGS:BEGIN([\s\S]*?)AGENT_LOGS:END/);
      if (!m) {
        throw new Error("Missing AGENT_LOGS markers in lib/main.dart");
      }

      // Extract desired logs line from prompt: after "logs:" section or just use full prompt
      let desired = prompt;

      // If prompt contains a "logs:" section, use only that part
      const lower = desired.toLowerCase();
      const idxLogs = lower.indexOf("logs:");
      if (idxLogs !== -1) {
        desired = desired.slice(idxLogs + 5);
      }

      desired = desired.replace(/\r/g, "").trim();


      // If user wrote a simple instruction, keep it short:
      // Replace everything between markers with lines prefixed "- "
      desired = desired
        .split("\n")
        .map(l => l.trim())
        .filter(l => l.length > 0)
        .slice(0, 6)
        .map(l => l.startsWith("-") ? l : `- ${l}`)
        .join("\n");

      // Put into Dart string literal: escape newlines
      desired = desired.replace(/\n/g, "\\n");

      const replacement = `AGENT_LOGS:BEGIN\\n${desired}\\nAGENT_LOGS:END`;
      main = main.replace(/AGENT_LOGS:BEGIN([\s\S]*?)AGENT_LOGS:END/, replacement);

      fs.writeFileSync(mainPath, main, "utf8");
      steps.push({ name: "feature_builder_ui_v1_patch", exitCode: 0 });
      return;


      const pubspecPath = path.join(projectDir, "pubspec.yaml");
      const dep = ensureSharedPrefs(pubspecPath);
      log(`[agent] pubspec shared_preferences ${dep.mode} changed=${dep.changed}`);

      const projectName = sanitizeProjectName(project);

      const files = [
        {
          file: path.join(projectDir, "lib", "features", "todo", "todo_repository.dart"),
          content: genTodoRepository(),
        },
        {
          file: path.join(projectDir, "lib", "features", "todo", "todo_screen.dart"),
          content: genTodoScreenV1(),
        },
        {
          file: path.join(projectDir, "lib", "main.dart"),
          content: genMain(appTitle, homeTitle),
        },
        {
          file: path.join(projectDir, "test", "widget_test.dart"),
          content: genWidgetTest(projectName, homeTitle),
        },
      ];

      let wrote = 0;
      for (const f of files) {
        const changed = writeFileIfChanged(f.file, f.content);
        log(`[agent] write ${path.relative(projectDir, f.file)} changed=${changed}`);
        if (changed) wrote++;
      }
      steps.push({ name: "feature_todo_v1_generate", exitCode: 0, wroteFiles: wrote });
    } else {
      log(`[agent] feature not todo_v1 (tip: use "feature: todo_v1")`);
    }

    // pub get
    {
      const code = await run("flutter", ["pub", "get"], projectDir);
      steps.push({ name: "flutter_pub_get", exitCode: code });
      if (code !== 0) { finalExit = code; throw new Error("flutter_pub_get_failed"); }
    }

    // analyze
    {
      const code = await run("flutter", ["analyze"], projectDir);
      steps.push({ name: "flutter_analyze", exitCode: code });
      if (code !== 0) { finalExit = code; throw new Error("flutter_analyze_failed"); }
    }

    // test
    {
      const code = await run("flutter", ["test"], projectDir);
      steps.push({ name: "flutter_test", exitCode: code });
      if (code !== 0) { finalExit = code; throw new Error("flutter_test_failed"); }

      if (mode === "step" && stopAfter === "registration") {
        log("[agent] pause gate reached: registration");
        console.log("AGENT_STATUS:PAUSED");
        await writeRunJson({
          status: "paused",
          exitCode: 0,
          steps,
          meta: {
            mode,
            stop_after: stopAfter,
            paused_at: "registration"
          }
        });
        process.exit(0);
      }
    }

    // optional build apk
    if (doBuildApk) {
      log(`[agent] checking android toolchain via flutter doctor -v`);
      const doc = await runCapture("flutter", ["doctor", "-v"], projectDir);
      steps.push({ name: "flutter_doctor_v", exitCode: doc.code });

      const androidBroken = /\[\s*✗\s*\]\s*Android toolchain/i.test(doc.output);
      if (androidBroken) {
        finalExit = 1;
        err("[agent] Android toolchain is not ready. Fix Flutter doctor issues, then retry with Build APK.");
        err("[agent] Hint: run: flutter doctor -v");
        throw new Error("android_toolchain_not_ready");
      }

      log(`[agent] building APK (debug)`);
      const code = await run("flutter", ["build", "apk", "--debug"], projectDir);
      steps.push({ name: "flutter_build_apk_debug", exitCode: code });
      if (code !== 0) { finalExit = code; throw new Error("flutter_build_apk_failed"); }

      const apk = apkPath(projectDir);
      if (fs.existsSync(apk)) log(`[agent] apk_ready=${apk}`);
      else err(`[agent] build reported success but apk not found at ${apk}`);
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

    // AUTO_LIVE_TRIGGER
    if (finalExit === 0) {
      try {
execSync(`bash "${repoRoot}/scripts/flutter_hot_reload.sh"`, { stdio: "inherit" });
        log("[agent] hot reload triggered");
        log("AGENT_STATUS:RELOAD_OK");
      } catch (e) {
        try {
execSync(`bash "${repoRoot}/scripts/run_live_flutter.sh" "${project}"`, { stdio: "inherit" });
          log("[agent] live flutter started");
          log("AGENT_STATUS:LIVE_STARTED");
        } catch (e2) {
          err("[agent] live trigger failed");
          log("AGENT_STATUS:LIVE_TRIGGER_FAILED");
        }
      }
    }

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


