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

// ------- MaterialApp title patch (scoped) + dedupe -------
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

// ------- process runners -------
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

// ------- run.json -------
function writeRunJson(payload) {
  fs.writeFileSync(path.join(projectDir, "run.json"), JSON.stringify(payload, null, 2), "utf8");
}

function apkPath(dir) {
  return path.join(dir, "build", "app", "outputs", "flutter-apk", "app-debug.apk");
}

// ------- feature generator (todo v0) -------
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}
function writeFileIfChanged(filePath, content) {
  const prev = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
  if (prev === content) return false;
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf8");
  return true;
}

function detectFeature(prompt) {
  // Explicit: feature: todo
  const f = parseField(prompt, "feature");
  if (f) return f.trim().toLowerCase();
  // Heuristic: if prompt contains word "todo"
  if (/\btodo\b/i.test(prompt)) return "todo";
  return null;
}

function genTodoFiles(appTitle) {
  const todoScreenPath = path.join(projectDir, "lib", "features", "todo", "todo_screen.dart");
  const mainPath = path.join(projectDir, "lib", "main.dart");
  const testPath = path.join(projectDir, "test", "widget_test.dart");

  const todoScreen = `import 'package:flutter/material.dart';

class TodoItem {
  TodoItem({required this.text, this.done = false});
  final String text;
  bool done;
}

class TodoScreen extends StatefulWidget {
  const TodoScreen({super.key, required this.title});
  final String title;

  @override
  State<TodoScreen> createState() => _TodoScreenState();
}

class _TodoScreenState extends State<TodoScreen> {
  final List<TodoItem> _items = <TodoItem>[
    TodoItem(text: 'Erste Aufgabe'),
    TodoItem(text: 'Zweite Aufgabe'),
  ];

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
    setState(() => _items.insert(0, TodoItem(text: result)));
  }

  void _toggle(int index) {
    setState(() => _items[index].done = !_items[index].done);
  }

  void _remove(int index) {
    setState(() => _items.removeAt(index));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      floatingActionButton: FloatingActionButton(
        onPressed: _addTodo,
        child: const Icon(Icons.add),
      ),
      body: ListView.separated(
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

  const mainDart = `import 'package:flutter/material.dart';
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
      home: const TodoScreen(title: "Todo Home"),
    );
  }
}
`;

  const widgetTest = `import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:todo_flutter/main.dart';

void main() {
  testWidgets('Todo app boots', (WidgetTester tester) async {
    await tester.pumpWidget(const MyApp());
    await tester.pumpAndSettle();

    // App bar title should exist.
    expect(find.text('Todo Home'), findsOneWidget);

    // Floating action button should exist.
    expect(find.byType(FloatingActionButton), findsOneWidget);
  });
}
`;

  return [
    { file: todoScreenPath, content: todoScreen },
    { file: mainPath, content: mainDart },
    { file: testPath, content: widgetTest },
  ];
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

    // Always ensure MaterialApp title stays aligned with prompt/title
    const titleFromPrompt = parseField(prompt, "title") ?? fallbackTitle(prompt);
    const mainDartPath = path.join(projectDir, "lib", "main.dart");
    const src0 = fs.readFileSync(mainDartPath, "utf8");
    let src = src0;
    const d = dedupeMaterialAppTitle(src);
    src = d.src;
    const t = setMaterialAppTitle(src, titleFromPrompt);
    src = t.src;
    if (src !== src0) fs.writeFileSync(mainDartPath, src, "utf8");
    log(`[agent] material_title mode=${t.mode} changed=${t.changed} value="${titleFromPrompt}"`);

    // Feature generation
    const feature = detectFeature(prompt);
    if (feature === "todo") {
      log(`[agent] feature=todo -> generating files`);
      const files = genTodoFiles(titleFromPrompt);
      let wrote = 0;
      for (const f of files) {
        const changed = writeFileIfChanged(f.file, f.content);
        log(`[agent] write ${path.relative(projectDir, f.file)} changed=${changed}`);
        if (changed) wrote++;
      }
      steps.push({ name: "feature_todo_generate", exitCode: 0, wroteFiles: wrote });
    } else {
      log(`[agent] feature=none (tip: use "feature: todo")`);
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
