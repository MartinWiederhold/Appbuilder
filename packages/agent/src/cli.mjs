#!/usr/bin/env node
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

globalThis.__filesChanged = false;


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
    spawnSync("bash", ["scripts/flutter_hot_reload_osascript.sh"], { stdio: "ignore" });
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
execSync(`bash "${repoRoot}/scripts/flutter_hot_reload_osascript.sh"`, { stdio: "inherit" });
        log("[agent] hot reload triggered");
        log("AGENT_STATUS:RELOAD_OK");
      } catch (e) {
        try {
execSync(`bash "${repoRoot}/scripts/run_live_flutter.sh"`, { stdio: "inherit" });
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


