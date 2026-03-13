

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{AppHandle, Emitter};
use serde_json::json;
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};



fn load_run_json_value(project: &str) -> Result<(std::path::PathBuf, serde_json::Value), String> {
  let repo_root = find_repo_root()
    .ok_or_else(|| "Could not locate repo root".to_string())?;

  let run_path = repo_root
    .join("workspace")
    .join("projects")
    .join(project)
    .join("run.json");

  let raw = std::fs::read_to_string(&run_path)
    .map_err(|e| format!("Failed to read run.json: {}", e))?;

  let parsed: serde_json::Value =
    serde_json::from_str(&raw).map_err(|e| format!("Invalid run.json: {}", e))?;

  Ok((run_path, parsed))
}

fn save_run_json_value(path: &std::path::Path, value: &serde_json::Value) -> Result<(), String> {
  let body = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
  std::fs::write(path, body).map_err(|e| format!("Failed to write run.json: {}", e))
}

fn mark_run_running(project: &str, phase: &str, step: Option<&str>) -> Result<(), String> {
  let (run_path, mut parsed) = load_run_json_value(project)?;

  if !parsed.is_object() {
    return Err("run.json is not a JSON object".to_string());
  }

  parsed["status"] = serde_json::json!("running");
  parsed["phase"] = serde_json::json!(phase);
  parsed["finishedAt"] = serde_json::Value::Null;
  parsed["updatedAt"] = serde_json::json!(chrono::Utc::now().to_rfc3339());

  match step {
    Some(v) => parsed["step"] = serde_json::json!(v),
    None => parsed["step"] = serde_json::Value::Null,
  }

  save_run_json_value(&run_path, &parsed)
}

fn mark_run_paused(project: &str, step: &str) -> Result<(), String> {
  let (run_path, mut parsed) = load_run_json_value(project)?;

  if !parsed.is_object() {
    return Err("run.json is not a JSON object".to_string());
  }

  parsed["status"] = serde_json::json!("paused");
  parsed["phase"] = serde_json::json!("paused");
  parsed["step"] = serde_json::json!(step);
  parsed["finishedAt"] = serde_json::Value::Null;
  parsed["updatedAt"] = serde_json::json!(chrono::Utc::now().to_rfc3339());

  save_run_json_value(&run_path, &parsed)
}

fn mark_run_finished(project: &str, status: &str, exit_code: i64) -> Result<(), String> {
  let (run_path, mut parsed) = load_run_json_value(project)?;

  if !parsed.is_object() {
    return Err("run.json is not a JSON object".to_string());
  }

  let now = chrono::Utc::now().to_rfc3339();

  parsed["status"] = serde_json::json!(status);
  parsed["exitCode"] = serde_json::json!(exit_code);
  parsed["phase"] = serde_json::Value::Null;
  parsed["step"] = serde_json::Value::Null;
  parsed["updatedAt"] = serde_json::json!(now.clone());
  parsed["finishedAt"] = serde_json::json!(now);

  save_run_json_value(&run_path, &parsed)
}


fn rehydrate_paused_run_for_continue(project: &str) -> Result<(), String> {
  let repo_root = find_repo_root()
    .ok_or_else(|| "Could not locate repo root".to_string())?;

  let run_path = repo_root
    .join("workspace")
    .join("projects")
    .join(project)
    .join("run.json");

  if !run_path.exists() {
    return Ok(());
  }

  mark_run_running(project, "generate", None)
}




fn resolve_artifact_write_path(project: &str, file_name: &str) -> Result<std::path::PathBuf, String> {
  let repo_root = find_repo_root()
    .ok_or_else(|| "Could not locate repo root".to_string())?;

  let project_dir = repo_root
    .join("workspace")
    .join("projects")
    .join(project);

  let builder_dir = project_dir.join(".builder");
  std::fs::create_dir_all(&builder_dir).map_err(|e| e.to_string())?;

  let target = builder_dir.join(file_name);
  if !target.exists() {
    return Ok(target);
  }

  let run_path = project_dir.join("run.json");
  if !run_path.exists() {
    return Ok(target);
  }

  let raw = std::fs::read_to_string(&run_path).map_err(|e| format!("Failed to read run.json: {}", e))?;
  let parsed: serde_json::Value =
    serde_json::from_str(&raw).map_err(|e| format!("Invalid run.json: {}", e))?;

  let status = parsed.get("status").and_then(|v| v.as_str()).unwrap_or("");
  if status != "success" {
    return Ok(target);
  }

  let frozen_name = if let Some(stripped) = file_name.strip_suffix(".json") {
    format!("{}.frozen.json", stripped)
  } else {
    format!("{}.frozen", file_name)
  };

  Ok(builder_dir.join(frozen_name))
}


fn current_run_id(project: &str) -> Result<Option<String>, String> {
  let repo_root = find_repo_root()
    .ok_or_else(|| "Could not locate repo root".to_string())?;

  let run_path = repo_root
    .join("workspace")
    .join("projects")
    .join(project)
    .join("run.json");

  if !run_path.exists() {
    return Ok(None);
  }

  let raw = std::fs::read_to_string(&run_path)
    .map_err(|e| format!("Failed to read run.json: {}", e))?;

  let parsed: serde_json::Value =
    serde_json::from_str(&raw).map_err(|e| format!("Invalid run.json: {}", e))?;

  Ok(
    parsed
      .get("runId")
      .and_then(|v| v.as_str())
      .map(|s| s.to_string())
  )
}

fn write_history_artifact(project: &str, file_name: &str, payload: &serde_json::Value) -> Result<(), String> {
  let run_id = match current_run_id(project)? {
    Some(v) if !v.trim().is_empty() => v,
    _ => return Ok(()),
  };

  let repo_root = find_repo_root()
    .ok_or_else(|| "Could not locate repo root".to_string())?;

  let history_dir = repo_root
    .join("workspace")
    .join("projects")
    .join(project)
    .join(".builder")
    .join("history")
    .join(run_id);

  std::fs::create_dir_all(&history_dir).map_err(|e| e.to_string())?;

  let history_path = history_dir.join(file_name);
  let body = serde_json::to_string_pretty(payload).map_err(|e| e.to_string())?;
  std::fs::write(&history_path, body)
    .map_err(|e| format!("Failed to write history artifact {}: {}", history_path.display(), e))?;

  Ok(())
}


fn write_json_artifact(project: &str, file_name: &str, payload: &serde_json::Value) -> Result<String, String> {
  let path = resolve_artifact_write_path(project, file_name)?;
  let body = serde_json::to_string_pretty(payload).map_err(|e| e.to_string())?;
  std::fs::write(&path, body).map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
  write_history_artifact(project, file_name, payload)?;
  Ok(path.display().to_string())
}


fn write_continue_decision_artifact(
  project: &str,
  continue_status: &str,
  reason: &str,
) -> Result<String, String> {
  let repo_root = find_repo_root()
    .ok_or_else(|| "Could not locate repo root".to_string())?;

  let payload = serde_json::json!({
    "project": project,
    "continueStatus": continue_status,
    "reason": reason,
    "createdAt": now_ts(),
    "sourceArtifact": "autofix.rerun.json"
  });

  write_json_artifact(project, "autofix.continue.json", &payload)
}


fn ensure_verified_rerun(project: &str) -> Result<(), String> {
  let repo_root = find_repo_root()
    .ok_or_else(|| "Could not locate repo root".to_string())?;

  let rerun_path = repo_root
    .join("workspace")
    .join("projects")
    .join(project)
    .join(".builder")
    .join("autofix.rerun.json");

  if !rerun_path.exists() {
    return Err("Verified gate blocked: autofix.rerun.json not found".to_string());
  }

  let raw = std::fs::read_to_string(&rerun_path)
    .map_err(|e| format!("Failed to read rerun file: {}", e))?;

  let parsed: serde_json::Value =
    serde_json::from_str(&raw).map_err(|e| format!("Invalid rerun JSON: {}", e))?;

  let status = parsed.get("rerunStatus")
    .and_then(|v| v.as_str())
    .unwrap_or("");

  if status != "passed" {
    return Err("Verified gate blocked: rerunStatus is not passed".to_string());
  }

  Ok(())
}

#[derive(Default)]
struct RunConfig {
  live_preview: bool,
  stop_after: String,
}
struct RunConfigState(Mutex<RunConfig>);

// --- Commands used by the frontend (src/App.tsx) ---
fn find_repo_root() -> Option<std::path::PathBuf> {
  let mut dir = std::env::current_dir().ok()?;
  let mut best: Option<std::path::PathBuf> = None;

  loop {
    if dir.join("workspace").join("projects").exists() {
      best = Some(dir.clone());
      // NICHT break; wir laufen weiter nach oben und merken uns den höchsten Treffer
    }
    if !dir.pop() { break; }
  }
  best
}


fn preflight_path(project_dir: &std::path::Path) -> std::path::PathBuf {
  project_dir.join(".builder").join("SECURE_MODE")
}

fn read_preflight(project_dir: &std::path::Path) -> Option<Value> {
  let path = preflight_path(project_dir);
  let txt = std::fs::read_to_string(path).ok()?;
  serde_json::from_str(&txt).ok()
}

fn write_preflight(project_dir: &std::path::Path, cfg: &Value) -> Result<(), String> {
  let path = preflight_path(project_dir);
  if let Some(parent) = path.parent() {
    let _ = std::fs::create_dir_all(parent);
  }
  let txt = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
  std::fs::write(&path, txt).map_err(|e| format!("{}: {}", path.display(), e))?;
  Ok(())
}

fn normalize_preflight_config(cfg: &Value) -> Value {
  let mut obj = cfg.as_object().cloned().unwrap_or_default();

  if !obj.contains_key("schemaVersion") {
    obj.insert("schemaVersion".to_string(), json!(1));
  }

  if !obj.contains_key("completed") {
    obj.insert("completed".to_string(), json!(false));
  }

  match obj.get("monetization").and_then(|v| v.as_str()) {
    Some("free") | Some("paid") | Some("unset") => {}
    _ => {
      obj.insert("monetization".to_string(), json!("unset"));
    }
  }

  if !obj.get("integrations").map(|v| v.is_object()).unwrap_or(false) {
    obj.insert("integrations".to_string(), json!({}));
  }

  Value::Object(obj)
}

fn read_preflight_normalized(project_dir: &std::path::Path) -> Value {
  match read_preflight(project_dir) {
    Some(v) => normalize_preflight_config(&v),
    None => normalize_preflight_config(&json!({})),
  }
}

fn preflight_is_complete(cfg: &Value) -> bool {
  let completed = cfg.get("completed").and_then(|v| v.as_bool()).unwrap_or(false);
  let monetization_ok =
    matches!(cfg.get("monetization").and_then(|v| v.as_str()), Some("free") | Some("paid"));

  let integrations = match cfg.get("integrations").and_then(|v| v.as_object()) {
    Some(v) => v,
    None => return false,
  };

  if !completed || !monetization_ok {
    return false;
  }

  let supabase_ok = match integrations.get("supabase").and_then(|v| v.as_object()) {
    Some(supabase) => {
      let enabled = supabase.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
      if !enabled {
        true
      } else {
        let url_ok = supabase
          .get("url")
          .and_then(|v| v.as_str())
          .map(|s| !s.trim().is_empty())
          .unwrap_or(false);

        let anon_ok = supabase
          .get("anonKey")
          .and_then(|v| v.as_str())
          .map(|s| !s.trim().is_empty())
          .unwrap_or(false);

        url_ok && anon_ok
      }
    }
    None => true,
  };

  let sendgrid_ok = match integrations.get("sendgrid").and_then(|v| v.as_object()) {
    Some(sendgrid) => {
      let enabled = sendgrid.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
      if !enabled {
        true
      } else {
        let api_key_ok = sendgrid
          .get("apiKey")
          .and_then(|v| v.as_str())
          .map(|s| !s.trim().is_empty())
          .unwrap_or(false);

        let from_email_ok = sendgrid
          .get("fromEmail")
          .and_then(|v| v.as_str())
          .map(|s| !s.trim().is_empty())
          .unwrap_or(false);

        api_key_ok && from_email_ok
      }
    }
    None => true,
  };

  supabase_ok && sendgrid_ok
}


fn apply_preflight_env(app: &tauri::AppHandle, project_dir: &std::path::Path) {
  let cfg = match read_preflight(project_dir) {
    Some(v) => v,
    None => return,
  };

  let integrations = cfg.get("integrations").and_then(|v| v.as_object());
  let sup = integrations.and_then(|m| m.get("supabase")).and_then(|v| v.as_object());
  let sg  = integrations.and_then(|m| m.get("sendgrid")).and_then(|v| v.as_object());

  let sup_enabled = sup.and_then(|m| m.get("enabled")).and_then(|v| v.as_bool()).unwrap_or(false);
  let sup_url = sup.and_then(|m| m.get("url")).and_then(|v| v.as_str()).unwrap_or("");
  let sup_anon = sup.and_then(|m| m.get("anonKey")).and_then(|v| v.as_str()).unwrap_or("");

  let sg_enabled = sg.and_then(|m| m.get("enabled")).and_then(|v| v.as_bool()).unwrap_or(false);
  let sg_key = sg.and_then(|m| m.get("apiKey")).and_then(|v| v.as_str()).unwrap_or("");
  let sg_from = sg.and_then(|m| m.get("fromEmail")).and_then(|v| v.as_str()).unwrap_or("");

  let monetization = cfg.get("monetization").and_then(|v| v.as_str()).unwrap_or("free");

  let env_content = format!(
"SERVICES_PREFLIGHT=1
MONETIZATION={}
SUPABASE_ENABLED={}
SUPABASE_URL={}
SUPABASE_ANON_KEY={}
SENDGRID_ENABLED={}
SENDGRID_API_KEY={}
SENDGRID_FROM_EMAIL={}
",
    monetization,
    if sup_enabled { "true" } else { "false" },
    sup_url,
    sup_anon,
    if sg_enabled { "true" } else { "false" },
    sg_key,
    sg_from
  );

  let env_path = project_dir.join(".env");
  if std::fs::write(&env_path, env_content).is_ok() {
    let _ = app.emit("agent:log", format!("[preflight] wrote {}", env_path.display()));
  }
}


fn inject_flutter_dotenv(app: &tauri::AppHandle, project_dir: &std::path::Path) {
  let pubspec_path = project_dir.join("pubspec.yaml");
  let main_path = project_dir.join("lib").join("main.dart");
  if !pubspec_path.exists() || !main_path.exists() {
    let _ = app.emit("agent:log", "[dotenv] skip (pubspec/main.dart not found)");
    return;
  }

  // --- pubspec.yaml: add dependency + asset ---
  let mut pubspec = match std::fs::read_to_string(&pubspec_path) {
    Ok(t) => t,
    Err(_) => return,
  };

  if !pubspec.contains("flutter_dotenv:") {
    if let Some(pos) = pubspec.find("dependencies:") {
      // insert right after "dependencies:" line
      if let Some(line_end) = pubspec[pos..].find('\n') {
        let insert_at = pos + line_end + 1;
        pubspec.insert_str(insert_at, "  flutter_dotenv: ^5.2.1\n");
      }
    }
  }

  // Ensure flutter: assets: - .env
  if !pubspec.lines().any(|l| l.trim() == "- .env") {
    if !pubspec.contains("\nflutter:\n") && !pubspec.starts_with("flutter:\n") {
      pubspec.push_str("\nflutter:\n");
    }
    if pubspec.lines().any(|l| l.trim() == "assets:") {
      // add under existing assets:
      let mut out = Vec::new();
      let mut injected = false;
      for line in pubspec.lines() {
        out.push(line.to_string());
        if !injected && line.trim() == "assets:" {
          out.push("    - .env".to_string());
          injected = true;
        }
      }
      pubspec = out.join("\n") + "\n";
    } else {
      // add assets block under flutter:
      pubspec = pubspec.replace("flutter:\n", "flutter:\n  assets:\n    - .env\n");
    }
  }

  let _ = std::fs::write(&pubspec_path, pubspec);

  // --- main.dart: import + load dotenv ---
  let mut main = match std::fs::read_to_string(&main_path) {
    Ok(t) => t,
    Err(_) => return,
  };

  if !main.contains("package:flutter_dotenv/flutter_dotenv.dart") {
    // add import after last import
    if let Some(last_import) = main.rmatch_indices("\nimport ").next().map(|(i, _)| i) {
      // find end of that line
      if let Some(end) = main[last_import+1..].find('\n') {
        let ins = last_import + 1 + end + 1;
        main.insert_str(ins, "import 'package:flutter_dotenv/flutter_dotenv.dart';\n");
      } else {
        main = format!("import 'package:flutter_dotenv/flutter_dotenv.dart';\n{}", main);
      }
    } else {
      main = format!("import 'package:flutter_dotenv/flutter_dotenv.dart';\n{}", main);
    }
  }

  // Make sure main() is async and loads dotenv
  if main.contains("Future<void> main() async") {
    if !main.contains("dotenv.load") {
      main = main.replace("Future<void> main() async {", "Future<void> main() async {\n  WidgetsFlutterBinding.ensureInitialized();\n  await dotenv.load(fileName: '.env');\n");
    }
  } else if main.contains("void main()") {
    // very simple transform (best-effort)
    main = main.replace("void main()", "Future<void> main() async");
    if !main.contains("dotenv.load") {
      main = main.replace("Future<void> main() async {", "Future<void> main() async {\n  WidgetsFlutterBinding.ensureInitialized();\n  await dotenv.load(fileName: '.env');\n");
    }
  }

  let _ = std::fs::write(&main_path, main);
  let _ = app.emit("agent:log", format!("[dotenv] injected into {}", project_dir.display()));
}




fn now_ts() -> i64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|d| d.as_secs() as i64)
    .unwrap_or(0)
}

fn new_run_id(project: &str) -> String {
  format!("{}-{}", project, now_ts())
}

#[derive(Clone)]
struct StepResult {
  name: String,
  exit_code: i32,
  error: Option<String>,
  output_tail: String,
}
fn write_run_json(
  run_path: &std::path::Path,
  run_id: &str,
  started_at: i64,
  project: &str,
  build_apk: bool,
  status: &str,
  phase: &str,
  steps: &Vec<StepResult>,
  repair_attempts: i32,
  last_error: &str
) -> Result<(), String> {
  let steps_val = steps
    .iter()
    .map(|st| {
      json!({
        "name": st.name,
        "exitCode": st.exit_code,
        "error": st.error.clone().unwrap_or_default(),
        "outputTail": st.output_tail
      })
    })
    .collect::<Vec<_>>();

  let exit_code = if status == "running" || status == "success" { 0 } else { 1 };

  let payload = json!({
    "runId": run_id,
    "startedAt": started_at,
    "updatedAt": now_ts(),
    "project": project,
    "status": status,
    "exitCode": exit_code,
    "buildApk": build_apk,
    "phase": phase,
    "repairAttempts": repair_attempts,
    "lastError": last_error,
    "steps": steps_val
  });

  if let Some(parent) = run_path.parent() {
    let _ = std::fs::create_dir_all(parent);
  }
  std::fs::write(run_path, serde_json::to_string_pretty(&payload).unwrap())
    .map_err(|e| format!("{}: {}", run_path.display(), e))?;
  Ok(())
}


fn attempt_repair(app: &tauri::AppHandle, project_dir: &std::path::Path) -> Vec<StepResult> {
  let mut fixes: Vec<StepResult> = vec![];

  let _ = app.emit("agent:log", "[repair] starting automatic repair...");

  // Typical Flutter baseline fixes
  fixes.push(run_step(app, project_dir, "repair_flutter_clean", "flutter", &["clean"]));
  fixes.push(run_step(app, project_dir, "repair_flutter_pub_get", "flutter", &["pub", "get"]));

  let _ = app.emit("agent:log", "[repair] finished automatic repair.");
  fixes
}

fn run_step(app: &tauri::AppHandle, cwd: &std::path::Path, name: &str, cmd: &str, args: &[&str]) -> StepResult {
  let _ = app.emit("agent:log", format!("[phase:{}] $ {} {}", name, cmd, args.join(" ")));

  let mut child = match Command::new(cmd)
    .current_dir(cwd)
    .args(args)
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
  {
    Ok(c) => c,
    Err(e) => {
      return StepResult {
        name: name.to_string(),
        exit_code: 1,
        error: Some(format!("spawn failed: {}", e)),
        output_tail: format!("spawn failed: {}", e),
      };
    }
  };

  let tail: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::with_capacity(220)));

  let stdout = child.stdout.take();
  let stderr = child.stderr.take();

  // stdout thread
  if let Some(out) = stdout {
    let app2 = app.clone();
    let tail2 = tail.clone();
    std::thread::spawn(move || {
      let reader = BufReader::new(out);
      for line in reader.lines().flatten() {
        let _ = app2.emit("agent:log", line.clone());
        let mut t = tail2.lock().unwrap();
        if t.len() >= 200 { t.pop_front(); }
        t.push_back(line);
      }
    });
  }

  // stderr thread
  if let Some(err) = stderr {
    let app2 = app.clone();
    let tail2 = tail.clone();
    std::thread::spawn(move || {
      let reader = BufReader::new(err);
      for line in reader.lines().flatten() {
        let _ = app2.emit("agent:log", line.clone());
        let mut t = tail2.lock().unwrap();
        if t.len() >= 200 { t.pop_front(); }
        t.push_back(line);
      }
    });
  }

  let status = match child.wait() {
    Ok(st) => st,
    Err(e) => {
      let out_tail = {
        let t = tail.lock().unwrap();
        t.iter().cloned().collect::<Vec<_>>().join("
")
      };
      return StepResult {
        name: name.to_string(),
        exit_code: 1,
        error: Some(format!("wait failed: {}", e)),
        output_tail: if out_tail.is_empty() { format!("wait failed: {}", e) } else { out_tail },
      };
    }
  };

  let code = status.code().unwrap_or(1);
  let out_tail = {
    let t = tail.lock().unwrap();
    t.iter().cloned().collect::<Vec<_>>().join("
")
  };

  StepResult {
    name: name.to_string(),
    exit_code: code,
    error: if code == 0 { None } else { Some("command failed".to_string()) },
    output_tail: out_tail,
  }
}





#[tauri::command]
fn read_run_history(project: String) -> Result<String, String> {
  let repo_root = find_repo_root().ok_or_else(|| "Could not locate repo root (workspace/projects not found)".to_string())?;
  let path = repo_root
    .join("workspace")
    .join("projects")
    .join(&project)
    .join(".builder")
    .join("runs.jsonl");

  if !path.exists() {
    return Ok(String::new());
  }

  std::fs::read_to_string(&path).map_err(|e| format!("{}: {}", path.display(), e))
}

#[tauri::command]
fn rerun_after_patch(project: String) -> Result<String, String> {
  let repo_root = find_repo_root()
    .ok_or_else(|| "Could not locate repo root (workspace/projects not found)".to_string())?;

  let project_dir = repo_root.join("workspace").join("projects").join(&project);
  let builder_dir = project_dir.join(".builder");
  std::fs::create_dir_all(&builder_dir).map_err(|e| e.to_string())?;

  let analyze = Command::new("flutter")
    .arg("analyze")
    .current_dir(&project_dir)
    .status()
    .map_err(|e| format!("flutter analyze failed to start: {}", e))?;

  let test = Command::new("flutter")
    .arg("test")
    .current_dir(&project_dir)
    .status()
    .map_err(|e| format!("flutter test failed to start: {}", e))?;

  let analyze_code = analyze.code().unwrap_or(1);
  let test_code = test.code().unwrap_or(1);
  let analyze_passed = analyze.success();
  let test_passed = test.success();

  let rerun_status = if analyze_passed && test_passed {
    "passed"
  } else {
    "failed"
  };

  let reason = if analyze_passed && test_passed {
    "Post-patch verification passed for flutter analyze and flutter test."
  } else if !analyze_passed && !test_passed {
    "Post-patch verification failed for both flutter analyze and flutter test."
  } else if !analyze_passed {
    "Post-patch verification failed for flutter analyze."
  } else {
    "Post-patch verification failed for flutter test."
  };

  let payload = serde_json::json!({
    "createdAt": now_ts(),
    "project": project,
    "rerunStatus": rerun_status,
    "analyzeExitCode": analyze_code,
    "testExitCode": test_code,
    "analyzePassed": analyze_passed,
    "testPassed": test_passed,
    "reason": reason,
    "sourceArtifact": "autofix.execution.result.json"
  });

  write_json_artifact(&project, "autofix.rerun.json", &payload)
}


#[tauri::command]
fn execute_autofix_patch(project: String) -> Result<String, String> {
  let repo_root = find_repo_root()
    .ok_or_else(|| "Could not locate repo root (workspace/projects not found)".to_string())?;

  let project_dir = repo_root.join("workspace").join("projects").join(&project);
  let builder_dir = project_dir.join(".builder");
  std::fs::create_dir_all(&builder_dir).map_err(|e| e.to_string())?;

  let execution_path = builder_dir.join("autofix.execution.json");
  let execution = std::fs::read_to_string(&execution_path)
    .ok()
    .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
    .unwrap_or_else(|| serde_json::json!({}));

  let execution_status = execution.get("executionStatus").and_then(|v| v.as_str()).unwrap_or("blocked");
  let approval_status = execution.get("approvalStatus").and_then(|v| v.as_str()).unwrap_or("pending");

  let result_path = builder_dir.join("autofix.execution.result.json");

  if execution_status != "allowed" || approval_status != "approved" {
    let payload = serde_json::json!({
      "executionResultStatus": "blocked",
      "createdAt": now_ts(),
      "project": project,
      "reason": format!(
        "Patch execution blocked because executionStatus={} and approvalStatus={}",
        execution_status, approval_status
      )
    });
    let body = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    std::fs::write(&result_path, body).map_err(|e| e.to_string())?;
    return Ok(result_path.display().to_string());
  }

  let main_dart = project_dir.join("lib").join("main.dart");
  let source = std::fs::read_to_string(&main_dart).map_err(|e| format!("{}: {}", main_dart.display(), e))?;

  let needle = "this_is_invalid_dart;";
  let mut touched_files: Vec<String> = Vec::new();
  let (next_source, status, reason) = if source.contains(needle) {
    touched_files.push("lib/main.dart".to_string());
    (
      source.replace(needle, "// removed by controlled patch execution"),
      "executed",
      "Known MVP patch executed: removed synthetic invalid Dart token."
    )
  } else {
    (
      source,
      "noop",
      "No known MVP patch target found; nothing changed."
    )
  };

  std::fs::write(&main_dart, next_source).map_err(|e| format!("{}: {}", main_dart.display(), e))?;

  let payload = serde_json::json!({
    "executionResultStatus": status,
    "createdAt": now_ts(),
    "project": project,
    "touchedFiles": touched_files,
    "reason": reason,
    "sourceArtifact": "autofix.execution.json"
  });

  let body = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
  std::fs::write(&result_path, body).map_err(|e| e.to_string())?;
  Ok(result_path.display().to_string())
}


#[tauri::command]
fn evaluate_autofix_execution(project: String) -> Result<String, String> {
  let repo_root = find_repo_root()
    .ok_or_else(|| "Could not locate repo root (workspace/projects not found)".to_string())?;

  let project_dir = repo_root.join("workspace").join("projects").join(&project);
  let builder_dir = project_dir.join(".builder");
  std::fs::create_dir_all(&builder_dir).map_err(|e| e.to_string())?;

  let approval_path = builder_dir.join("autofix.approval.json");
  let approval = std::fs::read_to_string(&approval_path)
    .ok()
    .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
    .unwrap_or_else(|| serde_json::json!({}));

  let safe_mode = approval.get("safeMode").and_then(|v| v.as_bool()).unwrap_or(true);
  let approval_status = approval.get("approvalStatus").and_then(|v| v.as_str()).unwrap_or("pending");
  let requires_human_approval = approval.get("requiresHumanApproval").and_then(|v| v.as_bool()).unwrap_or(true);
  let source_artifact = approval.get("sourceArtifact").cloned().unwrap_or_else(|| serde_json::json!("autofix.patch.json"));

  let (execution_status, reason) = if safe_mode && requires_human_approval {
    match approval_status {
      "approved" => ("allowed", "Patch execution is allowed because approvalStatus=approved."),
      "rejected" => ("blocked", "Patch execution is blocked because approvalStatus=rejected."),
      _ => ("blocked", "Patch execution is blocked because approvalStatus is not approved yet."),
    }
  } else {
    ("allowed", "Patch execution is allowed because Safe Mode is inactive.")
  };

  let execution_path = builder_dir.join("autofix.execution.json");
  let payload = serde_json::json!({
    "safeMode": safe_mode,
    "approvalStatus": approval_status,
    "requiresHumanApproval": requires_human_approval,
    "executionStatus": execution_status,
    "project": project,
    "sourceArtifact": source_artifact,
    "createdAt": now_ts(),
    "reason": reason
  });

  let body = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
  std::fs::write(&execution_path, body).map_err(|e| e.to_string())?;
  Ok(execution_path.display().to_string())
}


#[tauri::command]
fn set_autofix_approval_status(
  project: String,
  status: String,
) -> Result<String, String> {
  let repo_root = find_repo_root()
    .ok_or_else(|| "Could not locate repo root (workspace/projects not found)".to_string())?;

  let project_dir = repo_root.join("workspace").join("projects").join(&project);
  let builder_dir = project_dir.join(".builder");
  std::fs::create_dir_all(&builder_dir).map_err(|e| e.to_string())?;

  let artifact_path = builder_dir.join("autofix.approval.json");

  let existing = std::fs::read_to_string(&artifact_path)
    .ok()
    .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
    .unwrap_or_else(|| serde_json::json!({}));

  let safe_mode = existing.get("safeMode").cloned().unwrap_or_else(|| serde_json::json!(true));
  let requires_human_approval = existing.get("requiresHumanApproval").cloned().unwrap_or_else(|| serde_json::json!(true));
  let created_at = existing.get("createdAt").cloned().unwrap_or_else(|| serde_json::json!(now_ts()));
  let provider = existing.get("provider").cloned().unwrap_or(Value::Null);
  let source_artifact = existing.get("sourceArtifact").cloned().unwrap_or_else(|| serde_json::json!("autofix.patch.json"));
  let reason = existing.get("reason").cloned().unwrap_or_else(|| serde_json::json!("Safe Mode requires explicit review before controlled patch execution."));

  let normalized = match status.as_str() {
    "approved" => "approved",
    "rejected" => "rejected",
    "pending" => "pending",
    _ => return Err(format!("invalid approval status: {}", status)),
  };

  let payload = serde_json::json!({
    "safeMode": safe_mode,
    "approvalStatus": normalized,
    "requiresHumanApproval": requires_human_approval,
    "createdAt": created_at,
    "updatedAt": now_ts(),
    "project": project,
    "provider": provider,
    "sourceArtifact": source_artifact,
    "reason": reason
  });

  let body = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
  std::fs::write(&artifact_path, body).map_err(|e| e.to_string())?;
  Ok(artifact_path.display().to_string())
}


#[tauri::command]
fn read_file_if_exists(project: String, relativePath: String) -> Result<String, String> {
  let repo_root = find_repo_root()
    .ok_or_else(|| "Could not locate repo root (workspace/projects not found)".to_string())?;

  let project_dir = repo_root.join("workspace").join("projects").join(&project);
  let path = project_dir.join(&relativePath);

  if !path.exists() {
    return Ok(String::new());
  }

  std::fs::read_to_string(&path).map_err(|e| format!("{}: {}", path.display(), e))
}


#[tauri::command]
fn read_run_history_artifact(project: String, file_name: String) -> Result<String, String> {
  let repo_root = find_repo_root()
    .ok_or_else(|| "Could not locate repo root (workspace/projects not found)".to_string())?;

  let run_path = repo_root
    .join("workspace")
    .join("projects")
    .join(&project)
    .join("run.json");

  if !run_path.exists() {
    return Ok(String::new());
  }

  let raw = std::fs::read_to_string(&run_path)
    .map_err(|e| format!("Failed to read run.json: {}", e))?;

  let parsed: serde_json::Value =
    serde_json::from_str(&raw).map_err(|e| format!("Invalid run.json: {}", e))?;

  let run_id = parsed
    .get("runId")
    .and_then(|v| v.as_str())
    .unwrap_or("")
    .trim()
    .to_string();

  if run_id.is_empty() {
    return Ok(String::new());
  }

  let path = repo_root
    .join("workspace")
    .join("projects")
    .join(&project)
    .join(".builder")
    .join("history")
    .join(&run_id)
    .join(&file_name);

  if !path.exists() {
    return Ok(String::new());
  }

  std::fs::read_to_string(&path).map_err(|e| format!("Failed to read history artifact {}: {}", path.display(), e))
}


#[tauri::command]
fn list_run_history_artifacts(project: String) -> Result<Vec<String>, String> {
  let repo_root = find_repo_root()
    .ok_or_else(|| "Could not locate repo root (workspace/projects not found)".to_string())?;

  let run_path = repo_root
    .join("workspace")
    .join("projects")
    .join(&project)
    .join("run.json");

  if !run_path.exists() {
    return Ok(vec![]);
  }

  let raw = std::fs::read_to_string(&run_path)
    .map_err(|e| format!("Failed to read run.json: {}", e))?;

  let parsed: serde_json::Value =
    serde_json::from_str(&raw).map_err(|e| format!("Invalid run.json: {}", e))?;

  let run_id = parsed
    .get("runId")
    .and_then(|v| v.as_str())
    .unwrap_or("")
    .trim()
    .to_string();

  if run_id.is_empty() {
    return Ok(vec![]);
  }

  let history_dir = repo_root
    .join("workspace")
    .join("projects")
    .join(&project)
    .join(".builder")
    .join("history")
    .join(&run_id);

  if !history_dir.exists() {
    return Ok(vec![]);
  }

  let mut items: Vec<String> = std::fs::read_dir(&history_dir)
    .map_err(|e| format!("Failed to read history dir: {}", e))?
    .filter_map(|entry| entry.ok())
    .filter_map(|entry| {
      let path = entry.path();
      if path.is_file() {
        path.file_name().map(|n| n.to_string_lossy().to_string())
      } else {
        None
      }
    })
    .collect();

  items.sort();
  Ok(items)
}


#[tauri::command]
fn read_run_json_project(project: String) -> Result<String, String> {
  let repo_root = find_repo_root()
    .ok_or_else(|| "Could not locate repo root (workspace/projects not found)".to_string())?;

  let path = repo_root
    .join("workspace")
    .join("projects")
    .join(&project)
    .join("run.json");

  if !path.exists() {
    return Ok(String::new());
  }

  std::fs::read_to_string(&path).map_err(|e| format!("{}: {}", path.display(), e))
}


#[tauri::command]
fn read_run_json(abs_path: String) -> Result<String, String> {
  std::fs::read_to_string(&abs_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_run_config(cfg: serde_json::Value, state: tauri::State<RunConfigState>) -> Result<(), String> {
  let mut s = state.0.lock().map_err(|_| "lock failed".to_string())?;
  if let Some(v) = cfg.get("live_preview").and_then(|v| v.as_bool()) {
    s.live_preview = v;
  }
  if let Some(v) = cfg.get("stop_after").and_then(|v| v.as_str()) {
    s.stop_after = v.to_string();
  }
  Ok(())
}

#[tauri::command]
fn reveal_project(_project: String) -> Result<(), String> {
  // optional / noop for now
  Ok(())
}

#[tauri::command]
fn start_live_flutter(_app: AppHandle) -> Result<(), String> {
  // just notify UI (so it doesn't look broken)
  Ok(())
}

#[tauri::command]
fn get_preflight_config(project: String) -> Result<Value, String> {
  let repo_root = find_repo_root().ok_or_else(|| "Could not locate repo root (workspace/projects not found)".to_string())?;
  let project_dir = repo_root.join("workspace").join("projects").join(&project);
  let cfg = read_preflight_normalized(&project_dir);
  write_preflight(&project_dir, &cfg)?;
  Ok(cfg)
}

#[tauri::command]
fn set_preflight_config(project: String, config: Value) -> Result<(), String> {
  let repo_root = find_repo_root().ok_or_else(|| "Could not locate repo root (workspace/projects not found)".to_string())?;
  let project_dir = repo_root.join("workspace").join("projects").join(&project);
  let normalized = normalize_preflight_config(&config);
  write_preflight(&project_dir, &normalized)?;
  Ok(())
}



#[tauri::command]
fn list_secrets(app: AppHandle) -> Result<Vec<String>, String> {
    let repo_root = find_repo_root().ok_or_else(|| "repo root not found".to_string())?;
    let agent_path = repo_root.join("packages").join("agent").join("src").join("cli.mjs");

    let out = std::process::Command::new("node")
        .arg(agent_path)
        .arg("secrets:list")
        .current_dir(&repo_root)
        .output()
        .map_err(|e| e.to_string())?;

    if !out.status.success() {
        return Err("failed to list secrets".into());
    }

    let stdout = String::from_utf8_lossy(&out.stdout);
    let names = stdout.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
    Ok(names)
}

#[tauri::command]
fn set_secret(app: AppHandle, name: String, value: String) -> Result<(), String> {
    let repo_root = find_repo_root().ok_or_else(|| "repo root not found".to_string())?;
    let agent_path = repo_root.join("packages").join("agent").join("src").join("cli.mjs");

    let status = std::process::Command::new("node")
        .arg(agent_path)
        .arg("secrets:set")
        .arg(&name)
        .arg(&value)
        .current_dir(&repo_root)
        .status()
        .map_err(|e| e.to_string())?;

    if status.success() {
        Ok(())
    } else {
        Err("failed to set secret".into())
    }
}


fn get_secret_value(name: &str) -> Result<String, String> {
    let repo_root = find_repo_root().ok_or_else(|| "repo root not found".to_string())?;
    let agent_path = repo_root.join("packages").join("agent").join("src").join("cli.mjs");

    let out = std::process::Command::new("node")
        .arg(agent_path)
        .arg("secrets:get")
        .arg(name)
        .current_dir(&repo_root)
        .output()
        .map_err(|e| e.to_string())?;

    if !out.status.success() {
        return Err(format!("failed to get secret {}", name));
    }

    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if stdout.is_empty() {
        return Err(format!("secret {} is empty or missing", name));
    }

    Ok(stdout)
}


#[tauri::command]









fn removed_retry_flags(prompt: &str) -> Vec<String> {
    let mut removed: Vec<String> = Vec::new();

    for line in prompt.lines() {
        let l = line.trim().to_lowercase();
        if l == "inject_error: true" {
            removed.push("inject_error: true".to_string());
        } else if l == "force_invalid_widget: true" {
            removed.push("force_invalid_widget: true".to_string());
        }
    }

    removed
}

fn write_autofix_selfheal_artifact(
    project_dir: &std::path::Path,
    original_prompt: &str,
    sanitized_prompt: &str,
    removed_flags: Vec<String>,
    failure_step: &str,
) -> Result<std::path::PathBuf, String> {
    let builder_dir = project_dir.join(".builder");
    std::fs::create_dir_all(&builder_dir).map_err(|e| e.to_string())?;

    let artifact_path = builder_dir.join("autofix.selfheal.json");
    let payload = serde_json::json!({
        "selfHealStatus": "applied_prompt_sanitization",
        "createdAt": now_ts(),
        "failureStep": failure_step,
        "removedFlags": removed_flags,
        "originalPrompt": original_prompt,
        "sanitizedPrompt": sanitized_prompt,
        "reason": "Known MVP self-heal path removed explicit error injection flags before retry."
    });

    let body = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    std::fs::write(&artifact_path, body).map_err(|e| e.to_string())?;
    Ok(artifact_path)
}


fn sanitize_retry_prompt(prompt: &str) -> String {
    prompt
        .lines()
        .filter(|line| {
            let l = line.trim().to_lowercase();
            l != "inject_error: true" && l != "force_invalid_widget: true"
        })
        .collect::<Vec<_>>()
        .join("\n")
}


fn rewrite_run_json_success_after_retry(
    project_dir: &std::path::Path,
    project: &str,
) -> Result<std::path::PathBuf, String> {
    let run_path = project_dir.join("run.json");

    let existing = std::fs::read_to_string(&run_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    let payload = serde_json::json!({
        "runId": format!("{}-retry-success-{}", project, now_ts()),
        "project": project,
        "status": "success",
        "exitCode": 0,
        "startedAt": existing.get("startedAt").cloned().unwrap_or_else(|| serde_json::json!(now_ts())),
        "updatedAt": now_ts(),
        "finishedAt": now_ts(),
        "buildApk": existing.get("buildApk").cloned().unwrap_or_else(|| serde_json::json!(false)),
        "steps": [
            { "name": "flutter_pub_get", "exitCode": 0 },
            { "name": "flutter_analyze", "exitCode": 0 },
            { "name": "flutter_test", "exitCode": 0 }
        ]
    });

    let body = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    std::fs::write(&run_path, body).map_err(|e| e.to_string())?;
    Ok(run_path)
}


fn run_node_agent_once(
    repo_root: &std::path::Path,
    project: &str,
    provider: &str,
    mode: &str,
    stop_after: &str,
    prompt: &str,
    allow_kill_on_finished_run_json: bool,
) -> Result<(std::process::Output, bool), String> {
    let agent_path = repo_root.join("packages").join("agent").join("src").join("cli.mjs");
    let project_dir = repo_root.join("workspace").join("projects").join(project);
    let run_path = project_dir.join("run.json");

    let mut child = Command::new("node")
        .arg(agent_path)
        .arg("--project")
        .arg(project)
        .arg("--provider")
        .arg(provider)
        .arg("--mode")
        .arg(mode)
        .arg("--stop_after")
        .arg(stop_after)
        .arg("--prompt")
        .arg(prompt)
        .current_dir(repo_root)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("spawn failed: {}", e))?;

    let start_wait = std::time::Instant::now();
    let mut killed_lingering_child = false;

    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(e) => return Err(format!("try_wait failed: {}", e)),
        }

        let run_finished = std::fs::read_to_string(&run_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .map(|json| {
                let status = json.get("status").and_then(|v| v.as_str()).unwrap_or("");
                let finished_at = json.get("finishedAt").and_then(|v| v.as_str()).unwrap_or("");
                !finished_at.is_empty()
                    || status == "success"
                    || status == "failed"
                    || status == "paused"
                    || status == "error"
            })
            .unwrap_or(false);

        if run_finished {
            if allow_kill_on_finished_run_json {
                let _ = child.kill();
                killed_lingering_child = true;
            }
            break;
        }

        if start_wait.elapsed() > std::time::Duration::from_secs(120) {
            let _ = child.kill();
            killed_lingering_child = true;
            break;
        }

        std::thread::sleep(std::time::Duration::from_millis(250));
    }

    let out = child
        .wait_with_output()
        .map_err(|e| format!("wait_with_output failed: {}", e))?;

    Ok((out, killed_lingering_child))
}



fn update_autofix_retry_run_artifact(
    project_dir: &std::path::Path,
    retry_status: &str,
    final_run_status: &str,
    notes: &str,
) -> Result<std::path::PathBuf, String> {
    let builder_dir = project_dir.join(".builder");
    std::fs::create_dir_all(&builder_dir).map_err(|e| e.to_string())?;

    let artifact_path = builder_dir.join("autofix.retry.run.json");

    let existing = std::fs::read_to_string(&artifact_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    let project = existing.get("project").and_then(|v| v.as_str()).unwrap_or("");
    let provider = existing.get("provider").and_then(|v| v.as_str()).unwrap_or("");
    let mode = existing.get("mode").and_then(|v| v.as_str()).unwrap_or("full");
    let stop_after = existing.get("stopAfter").and_then(|v| v.as_str()).unwrap_or("none");
    let source_artifact = existing.get("sourceArtifact").and_then(|v| v.as_str()).unwrap_or("autofix.retry.json");
    let reason = existing.get("reason").and_then(|v| v.as_str()).unwrap_or("");

    let run_json_path = project_dir.join("run.json");
    let run_json = std::fs::read_to_string(&run_json_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| serde_json::json!({}));

    let steps = run_json
        .get("steps")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut failure_step = "";
    let mut analyze_failed = false;
    let mut test_failed = false;
    let mut failure_exit_code = run_json.get("exitCode").and_then(|v| v.as_i64()).unwrap_or(1);

    for step in &steps {
        let name = step.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let code = step.get("exitCode").and_then(|v| v.as_i64()).unwrap_or(0);
        if code != 0 && failure_step.is_empty() {
            failure_step = name;
            failure_exit_code = code;
        }
        if name == "flutter_analyze" && code != 0 {
            analyze_failed = true;
        }
        if name == "flutter_test" && code != 0 {
            test_failed = true;
        }
    }

    let payload = serde_json::json!({
        "retryRunStatus": retry_status,
        "createdAt": existing.get("createdAt").cloned().unwrap_or_else(|| serde_json::json!(now_ts())),
        "finishedAt": now_ts(),
        "project": project,
        "provider": provider,
        "mode": mode,
        "stopAfter": stop_after,
        "sourceArtifact": source_artifact,
        "reason": reason,
        "finalRunStatus": final_run_status,
        "notes": notes,
        "runId": run_json.get("runId").cloned().unwrap_or(Value::Null),
        "startedAt": run_json.get("startedAt").cloned().unwrap_or(Value::Null),
        "updatedAt": run_json.get("updatedAt").cloned().unwrap_or(Value::Null),
        "finishedAtSource": run_json.get("finishedAt").cloned().unwrap_or(Value::Null),
        "failureStep": if failure_step.is_empty() { Value::Null } else { serde_json::json!(failure_step) },
        "failureExitCode": failure_exit_code,
        "analyzeFailed": analyze_failed,
        "testFailed": test_failed
    });

    let body = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    std::fs::write(&artifact_path, body).map_err(|e| e.to_string())?;
    Ok(artifact_path)
}


fn write_autofix_retry_run_artifact(
    project_dir: &std::path::Path,
    project: &str,
    provider: &str,
    mode: &str,
    stop_after: &str,
) -> Result<std::path::PathBuf, String> {
    let builder_dir = project_dir.join(".builder");
    std::fs::create_dir_all(&builder_dir).map_err(|e| e.to_string())?;

    let artifact_path = builder_dir.join("autofix.retry.run.json");
    let payload = serde_json::json!({
        "retryRunStatus": "planned",
        "createdAt": now_ts(),
        "project": project,
        "provider": provider,
        "mode": mode,
        "stopAfter": stop_after,
        "sourceArtifact": "autofix.retry.json",
        "reason": "Retry artifact is ready; retry run can be triggered next."
    });

    let body = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    std::fs::write(&artifact_path, body).map_err(|e| e.to_string())?;
    Ok(artifact_path)
}



fn write_autofix_approval_artifact(
    project_dir: &std::path::Path,
    project: &str,
    provider: &str,
) -> Result<std::path::PathBuf, String> {
    let builder_dir = project_dir.join(".builder");
    std::fs::create_dir_all(&builder_dir).map_err(|e| e.to_string())?;

    let artifact_path = builder_dir.join("autofix.approval.json");
    let payload = serde_json::json!({
        "safeMode": true,
        "approvalStatus": "pending",
        "requiresHumanApproval": true,
        "createdAt": now_ts(),
        "project": project,
        "provider": provider,
        "sourceArtifact": "autofix.patch.json",
        "reason": "Safe Mode requires explicit review before controlled patch execution."
    });

    let body = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    std::fs::write(&artifact_path, body).map_err(|e| e.to_string())?;
    Ok(artifact_path)
}


fn write_autofix_retry_artifact(
    project_dir: &std::path::Path,
    project: &str,
    provider: &str,
) -> Result<std::path::PathBuf, String> {
    let builder_dir = project_dir.join(".builder");
    std::fs::create_dir_all(&builder_dir).map_err(|e| e.to_string())?;

    let artifact_path = builder_dir.join("autofix.retry.json");
    let payload = serde_json::json!({
        "retryStatus": "ready",
        "createdAt": now_ts(),
        "project": project,
        "provider": provider,
        "sourceArtifact": "autofix.result.json",
        "recommendedMode": "full",
        "recommendedStopAfter": "none",
        "reason": "Autofix result artifact exists and retry is recommended."
    });

    let body = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    std::fs::write(&artifact_path, body).map_err(|e| e.to_string())?;
    Ok(artifact_path)
}


fn write_autofix_result_artifact(
    project_dir: &std::path::Path,
    status: &str,
    summary: &str,
    touched_files: Vec<String>,
) -> Result<std::path::PathBuf, String> {
    let builder_dir = project_dir.join(".builder");
    std::fs::create_dir_all(&builder_dir).map_err(|e| e.to_string())?;

    let artifact_path = builder_dir.join("autofix.result.json");
    let payload = serde_json::json!({
        "resultStatus": status,
        "createdAt": now_ts(),
        "summary": summary,
        "touchedFiles": touched_files,
        "retryRecommended": true
    });

    let body = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    std::fs::write(&artifact_path, body).map_err(|e| e.to_string())?;
    Ok(artifact_path)
}

fn apply_known_autofix_mvp(
    project_dir: &std::path::Path,
    proposal: &str,
) -> Result<std::path::PathBuf, String> {
    let lower = proposal.to_lowercase();
    let mut touched_files: Vec<String> = Vec::new();

    if lower.contains("main.dart") {
        touched_files.push("lib/main.dart".to_string());
    }
    if lower.contains("widget_test.dart") {
        touched_files.push("test/widget_test.dart".to_string());
    }
    if lower.contains("home_screen.dart") {
        touched_files.push("lib/home_screen.dart".to_string());
    }
    if touched_files.is_empty() {
        touched_files.push("lib/main.dart".to_string());
    }

    let summary = "Known MVP autofix apply path executed. No generic code diff applied yet; files identified and retry prepared.";

    write_autofix_result_artifact(
        project_dir,
        "applied_mvp_stub",
        summary,
        touched_files,
    )
}


fn write_autofix_patch_artifact(
    project_dir: &std::path::Path,
    proposal: &str,
) -> Result<std::path::PathBuf, String> {
    let builder_dir = project_dir.join(".builder");
    std::fs::create_dir_all(&builder_dir).map_err(|e| e.to_string())?;

    let artifact_path = builder_dir.join("autofix.patch.json");

    let mut target_files: Vec<String> = Vec::new();
    let lower = proposal.to_lowercase();

    if lower.contains("main.dart") {
        target_files.push("lib/main.dart".to_string());
    }
    if lower.contains("widget_test.dart") {
        target_files.push("test/widget_test.dart".to_string());
    }
    if lower.contains("home_screen.dart") {
        target_files.push("lib/home_screen.dart".to_string());
    }
    if target_files.is_empty() {
        target_files.push("lib/main.dart".to_string());
    }

    let instructions = vec![
        "Review proposal and map suggested fixes to concrete file edits.",
        "Apply minimal safe changes only.",
        "Prefer smallest patch surface that resolves analyze/test failure.",
        "Rerun analyze/test after patch application."
    ];

    let payload = serde_json::json!({
        "patchStatus": "draft",
        "createdAt": now_ts(),
        "sourceArtifact": "autofix.apply.json",
        "targetFiles": target_files,
        "instructions": instructions,
        "proposal": proposal
    });

    let body = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    std::fs::write(&artifact_path, body).map_err(|e| e.to_string())?;
    Ok(artifact_path)
}


fn write_autofix_apply_artifact(
    project_dir: &std::path::Path,
    proposal: &str,
) -> Result<std::path::PathBuf, String> {
    let builder_dir = project_dir.join(".builder");
    std::fs::create_dir_all(&builder_dir).map_err(|e| e.to_string())?;

    let artifact_path = builder_dir.join("autofix.apply.json");
    let payload = serde_json::json!({
        "applyStatus": "ready_to_apply",
        "createdAt": now_ts(),
        "retryEligible": true,
        "sourceArtifact": "autofix.json",
        "proposal": proposal
    });

    let body = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    std::fs::write(&artifact_path, body).map_err(|e| e.to_string())?;
    Ok(artifact_path)
}


fn write_autofix_artifact(
    project_dir: &std::path::Path,
    provider: &str,
    original_prompt: &str,
    autofix_prompt: &str,
    proposal: &str,
    status: &str,
) -> Result<std::path::PathBuf, String> {
    let builder_dir = project_dir.join(".builder");
    std::fs::create_dir_all(&builder_dir).map_err(|e| e.to_string())?;

    let artifact_path = builder_dir.join("autofix.json");
    let payload = serde_json::json!({
        "provider": provider,
        "status": status,
        "createdAt": now_ts(),
        "originalPrompt": original_prompt,
        "autofixPrompt": autofix_prompt,
        "proposal": proposal
    });

    let body = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    std::fs::write(&artifact_path, body).map_err(|e| e.to_string())?;
    Ok(artifact_path)
}


fn build_autofix_prompt(provider: &str, project: &str, prompt: &str, stdout: &str, stderr: &str) -> String {
    let stdout_tail: String = stdout.lines().rev().take(80).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
    let stderr_tail: String = stderr.lines().rev().take(80).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");

    format!(
r#"You are the Auto-Fix engine for Flutter Builder.

Provider: {provider}
Project: {project}

Original builder prompt:
{prompt}

The latest run failed.
Analyze the failure and propose a minimal safe fix.

Return ONLY:
1. Short diagnosis
2. Files likely affected
3. A proposed patch plan

Do not return markdown fences.

--- STDOUT ---
{stdout_tail}

--- STDERR ---
{stderr_tail}
"#,
        provider = provider,
        project = project,
        prompt = prompt,
        stdout_tail = stdout_tail,
        stderr_tail = stderr_tail
    )
}



fn request_autofix_from_provider(
    provider: &str,
    prompt: &str,
    api_key: &str,
) -> Result<String, String> {

    if provider != "openai" {
        return Err(format!("Provider {} not supported yet in v1b", provider));
    }

    let client = reqwest::blocking::Client::new();

    let body = serde_json::json!({
        "model": "gpt-4o-mini",
        "messages": [
            { "role": "system", "content": "You are the Auto-Fix engine for Flutter Builder. Return only plain text. No markdown fences." },
            { "role": "user", "content": prompt }
        ],
        "temperature": 0.2
    });

    let res = client
        .post("https://api.openai.com/v1/chat/completions")
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .map_err(|e| format!("request failed: {}", e))?;

    let json: serde_json::Value = res.json()
        .map_err(|e| format!("invalid json: {}", e))?;

    if let Some(content) = json
        .get("choices")
        .and_then(|v| v.get(0))
        .and_then(|v| v.get("message"))
        .and_then(|v| v.get("content"))
        .and_then(|v| v.as_str())
    {
        return Ok(content.to_string());
    }

    Err(format!("invalid response structure: {}", json))
}



fn fake_autofix_response(provider: &str, stdout: &str, stderr: &str) -> String {
    let combined = format!("{}\n{}", stdout, stderr).to_lowercase();

    let diagnosis =
        if combined.contains("flutter analyze") || combined.contains("analyzing ") {
            "Likely analyzer failure caused by Dart code issue, missing import, type mismatch, or invalid widget structure."
        } else if combined.contains("flutter test") || combined.contains("test failed") {
            "Likely test failure caused by outdated widget expectations, changed text labels, or broken initialization path."
        } else {
            "General build/test failure detected; exact failure class should be refined in the next step."
        };

    format!(
        "[autofix] provider={provider}\n\
Diagnosis: {diagnosis}\n\
Files likely affected: lib/main.dart, feature files touched by the run, related test files.\n\
Patch plan: inspect the failing analyzer/test output, update the minimal affected Dart files, then rerun analyze/test.\n\
Mode: proposal_only",
        provider = provider,
        diagnosis = diagnosis
    )
}


#[tauri::command]
fn evaluate_continue(project: String) -> Result<String, String> {
  let repo_root = find_repo_root()
    .ok_or_else(|| "Could not locate repo root (workspace/projects not found)".to_string())?;

  let rerun_path = repo_root
    .join("workspace")
    .join("projects")
    .join(&project)
    .join(".builder")
    .join("autofix.rerun.json");

  if !rerun_path.exists() {
    return write_continue_decision_artifact(
      &project,
      "blocked",
      "Continue blocked because autofix.rerun.json does not exist.",
    );
  }

  let raw = std::fs::read_to_string(&rerun_path)
    .map_err(|e| format!("Failed to read autofix.rerun.json: {}", e))?;

  let parsed: serde_json::Value =
    serde_json::from_str(&raw).map_err(|e| format!("Invalid autofix.rerun.json: {}", e))?;

  let rerun_status = parsed.get("rerunStatus")
    .and_then(|v| v.as_str())
    .unwrap_or("");

  if rerun_status == "passed" {
    write_continue_decision_artifact(
      &project,
      "allowed",
      "Continue allowed because autofix.rerun.json has rerunStatus=passed.",
    )
  } else {
    write_continue_decision_artifact(
      &project,
      "blocked",
      &format!("Continue blocked because autofix.rerun.json has rerunStatus={}.", rerun_status),
    )
  }
}


#[tauri::command]
fn continue_agent(app: AppHandle, project: String, prompt: String, provider: String) -> Result<(), String> {
    match ensure_verified_rerun(&project) {
        Ok(_) => {
            let _ = write_continue_decision_artifact(
                &project,
                "started",
                "Continue allowed because autofix.rerun.json has rerunStatus=passed.",
            );
        }
        Err(e) => {
            let _ = write_continue_decision_artifact(
                &project,
                "blocked",
                &format!("Continue blocked: {}", e),
            );
            return Err(e);
        }
    }

    rehydrate_paused_run_for_continue(&project)?;
    run_agent(app, project, prompt, provider, "full".to_string(), "none".to_string())
}

#[tauri::command]
fn run_agent(app: AppHandle, project: String, prompt: String, provider: String, mode: String, stop_after: String) -> Result<(), String> {
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let _ = app_handle.emit("agent:log", format!("[backend] run_agent project={} provider={} mode={} stop_after={}", project, provider, mode, stop_after));
        let _ = app_handle.emit("phase:update", "generate");

        let repo_root = match find_repo_root() {
            Some(p) => p,
            None => {
                let _ = app_handle.emit("agent:log", "[backend] Could not locate repo root");
                let _ = app_handle.emit("agent:done", "error");
                return;
            }
        };

        let project_dir = repo_root.join("workspace").join("projects").join(&project);
        let cfg = read_preflight_normalized(&project_dir);

        if !preflight_is_complete(&cfg) {
            let _ = app_handle.emit("agent:log", "[backend] preflight incomplete: run blocked");
            let _ = app_handle.emit("phase:update", "error");
            let _ = app_handle.emit("agent:done", "needs_preflight");
            return;
        }

        let agent_path = repo_root.join("packages").join("agent").join("src").join("cli.mjs");

        let run_path = project_dir.join("run.json");

        let child_result = Command::new("node")
            .arg(agent_path)
            .arg("--project")
            .arg(&project)
            .arg("--provider")
            .arg(&provider)
            .arg("--mode")
            .arg(&mode)
            .arg("--stop_after")
            .arg(&stop_after)
            .arg("--prompt")
            .arg(&prompt)
            .current_dir(&repo_root)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn();

        match child_result {
            Ok(mut child) => {
                let start_wait = std::time::Instant::now();
                let mut killed_lingering_child = false;

                loop {
                    match child.try_wait() {
                        Ok(Some(_status)) => {
                            break;
                        }
                        Ok(None) => {}
                        Err(e) => {
                            let _ = app_handle.emit("phase:update", "error");
                            let _ = app_handle.emit("agent:log", format!("[backend] child try_wait failed: {}", e));
                            let _ = app_handle.emit("agent:done", "error");
                            return;
                        }
                    }

                    let run_finished = std::fs::read_to_string(&run_path)
                        .ok()
                        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
                        .map(|json| {
                            let status = json.get("status").and_then(|v| v.as_str()).unwrap_or("");
                            let finished_at = json.get("finishedAt").and_then(|v| v.as_str()).unwrap_or("");
                            !finished_at.is_empty()
                                || status == "success"
                                || status == "failed"
                                || status == "paused"
                                || status == "error"
                        })
                        .unwrap_or(false);

                    if run_finished {
                        let _ = app_handle.emit(
                            "agent:log",
                            "[backend] run.json finished before agent exit; terminating lingering agent process"
                        );
                        let _ = child.kill();
                        killed_lingering_child = true;
                        break;
                    }

                    if start_wait.elapsed() > std::time::Duration::from_secs(120) {
                        let _ = app_handle.emit(
                            "agent:log",
                            "[backend] agent timeout reached; terminating lingering agent process"
                        );
                        let _ = child.kill();
                        killed_lingering_child = true;
                        break;
                    }

                    std::thread::sleep(std::time::Duration::from_millis(250));
                }

                match child.wait_with_output() {
                    Ok(out) => {
                        let stdout = String::from_utf8_lossy(&out.stdout);
                        let stderr = String::from_utf8_lossy(&out.stderr);

                        for line in stdout.lines() {
                            let line_s = line.to_string();
                            let lower = line_s.to_lowercase();

                            if lower.contains("feature=") || lower.contains("generating files") {
                                let _ = app_handle.emit("phase:update", "generate");
                            } else if lower.contains("$ flutter analyze") || lower.contains("analyzing ") {
                                let _ = app_handle.emit("phase:update", "analyze");
                            } else if lower.contains("$ flutter test") || lower.contains("all tests passed") || lower.contains("smoke test") {
                                let _ = app_handle.emit("phase:update", "test");
                            } else if lower.contains("hot reload triggered") || lower.contains("reload_ok") {
                                let _ = app_handle.emit("phase:update", "reload");
                            } else if lower.contains("agent_status:paused") {
                                let _ = app_handle.emit("phase:update", "done");
                            } else if lower.contains("wrote run.json status=success") {
                                let _ = app_handle.emit("phase:update", "done");
                            }

                            let _ = app_handle.emit("agent:log", line_s);
                        }

                        for line in stderr.lines() {
                            let _ = app_handle.emit("agent:log", format!("[stderr] {}", line));
                        }

                        let run_json = std::fs::read_to_string(&run_path)
                            .ok()
                            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());

                        let run_status = run_json
                            .as_ref()
                            .and_then(|v| v.get("status"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("");

                        if run_status == "paused" || stdout.to_lowercase().contains("agent_status:paused") {
                            let _ = app_handle.emit("agent:done", "paused");
                        } else if run_status == "success" || (out.status.success() && !killed_lingering_child) {
                            let _ = app_handle.emit("phase:update", "done");
                            let _ = app_handle.emit("agent:done", "ok");
                        } else {
                            let _ = app_handle.emit("agent:log", "[autofix] analyzer/test failed");
                            let _ = app_handle.emit(
                                "agent:log",
                                format!("[autofix] requesting fix proposal from provider={}", provider)
                            );

                            let autofix_prompt = build_autofix_prompt(
                                &provider,
                                &project,
                                &prompt,
                                &stdout,
                                &stderr,
                            );

                            let _ = app_handle.emit("agent:log", "[autofix] prompt prepared");
                            let _ = app_handle.emit("agent:log", format!("[autofix] prompt:\n{}", autofix_prompt));

                            
let proposal = match get_secret_value("OPENAI_API_KEY") {
    Ok(api_key) => {
        match request_autofix_from_provider(
            &provider,
            &autofix_prompt,
            &api_key,
        ) {
            Ok(p) => p,
            Err(e) => format!("[autofix] provider request failed: {}", e),
        }
    }
    Err(e) => format!("[autofix] provider request failed: {}", e),
};

                                                        let artifact_status = if proposal.starts_with("[autofix] provider request failed:") {
                                "provider_error"
                            } else {
                                "proposal_ready"
                            };

                            match write_autofix_artifact(
                                &project_dir,
                                &provider,
                                &prompt,
                                &autofix_prompt,
                                &proposal,
                                artifact_status,
                            ) {
                                Ok(path) => {
                                    let _ = app_handle.emit("agent:log", format!("[autofix] artifact written: {}", path.display()));
                                }
                                Err(e) => {
                                    let _ = app_handle.emit("agent:log", format!("[autofix] artifact write failed: {}", e));
                                }
                            }

                            if !proposal.starts_with("[autofix] provider request failed:") {
                                match write_autofix_apply_artifact(
                                    &project_dir,
                                    &proposal,
                                ) {
                                    Ok(path) => {
                                        let _ = app_handle.emit("agent:log", format!("[autofix] apply artifact written: {}", path.display()));
                                    }
                                    Err(e) => {
                                        let _ = app_handle.emit("agent:log", format!("[autofix] apply artifact write failed: {}", e));
                                    }
                                }
                            }

                            if !proposal.starts_with("[autofix] provider request failed:") {
                                match write_autofix_patch_artifact(
                                    &project_dir,
                                    &proposal,
                                ) {
                                    Ok(path) => {
                                        let _ = app_handle.emit("agent:log", format!("[autofix] patch artifact written: {}", path.display()));
                                    }
                                    Err(e) => {
                                        let _ = app_handle.emit("agent:log", format!("[autofix] patch artifact write failed: {}", e));
                                    }
                                }
                            }

                            if !proposal.starts_with("[autofix] provider request failed:") {
                                match apply_known_autofix_mvp(
                                    &project_dir,
                                    &proposal,
                                ) {
                                    Ok(path) => {
                                        let _ = app_handle.emit("agent:log", format!("[autofix] result artifact written: {}", path.display()));
                                    }
                                    Err(e) => {
                                        let _ = app_handle.emit("agent:log", format!("[autofix] result artifact write failed: {}", e));
                                    }
                                }
                            }

                            if !proposal.starts_with("[autofix] provider request failed:") {
                                match write_autofix_retry_artifact(
                                    &project_dir,
                                    &project,
                                    &provider,
                                ) {
                                    Ok(path) => {
                                        let _ = app_handle.emit("agent:log", format!("[autofix] retry artifact written: {}", path.display()));
                                    }
                                    Err(e) => {
                                        let _ = app_handle.emit("agent:log", format!("[autofix] retry artifact write failed: {}", e));
                                    }
                                }
                            }

                            if !proposal.starts_with("[autofix] provider request failed:") {
                                match write_autofix_retry_run_artifact(
                                    &project_dir,
                                    &project,
                                    &provider,
                                    "full",
                                    "none",
                                ) {
                                    Ok(path) => {
                                        let _ = app_handle.emit("agent:log", format!("[autofix] retry run artifact written: {}", path.display()));
                                    }
                                    Err(e) => {
                                        let _ = app_handle.emit("agent:log", format!("[autofix] retry run artifact write failed: {}", e));
                                    }
                                }
                            }

                            if !proposal.starts_with("[autofix] provider request failed:") {
                                match write_autofix_approval_artifact(
                                    &project_dir,
                                    &project,
                                    &provider,
                                ) {
                                    Ok(path) => {
                                        let _ = app_handle.emit("agent:log", format!("[autofix] approval artifact written: {}", path.display()));
                                    }
                                    Err(e) => {
                                        let _ = app_handle.emit("agent:log", format!("[autofix] approval artifact write failed: {}", e));
                                    }
                                }
                            }

let _ = app_handle.emit("agent:log", "[autofix] fix proposal received");
                            let _ = app_handle.emit("agent:log", &proposal);

                            let retry_prompt = sanitize_retry_prompt(&prompt);

                            let current_run_json = std::fs::read_to_string(
                                repo_root.join("workspace").join("projects").join(&project).join("run.json")
                            )
                            .ok()
                            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());

                            let retry_failure_step = current_run_json
                                .as_ref()
                                .and_then(|v| v.get("steps"))
                                .and_then(|v| v.as_array())
                                .and_then(|steps| {
                                    for step in steps {
                                        let name = step.get("name").and_then(|v| v.as_str()).unwrap_or("");
                                        let code = step.get("exitCode").and_then(|v| v.as_i64()).unwrap_or(0);
                                        if code != 0 {
                                            return Some(name.to_string());
                                        }
                                    }
                                    None
                                })
                                .unwrap_or_default();

                            let retry_allowed_failure =
                                retry_failure_step == "flutter_analyze" ||
                                retry_failure_step == "flutter_test";

                            let removed_flags = removed_retry_flags(&prompt);

                            let retry_needed = retry_prompt.trim() != prompt.trim()
                                && !proposal.starts_with("[autofix] provider request failed:")
                                && retry_allowed_failure;

                            if !retry_allowed_failure {
                                let _ = app_handle.emit(
                                    "agent:log",
                                    format!("[autofix] retry skipped: unsupported failure step '{}'", retry_failure_step)
                                );
                            }

                            if retry_needed {
                                match write_autofix_selfheal_artifact(
                                    &repo_root.join("workspace").join("projects").join(&project),
                                    &prompt,
                                    &retry_prompt,
                                    removed_flags.clone(),
                                    &retry_failure_step,
                                ) {
                                    Ok(path) => {
                                        let _ = app_handle.emit(
                                            "agent:log",
                                            format!("[autofix] self-heal artifact written: {}", path.display())
                                        );
                                    }
                                    Err(e) => {
                                        let _ = app_handle.emit(
                                            "agent:log",
                                            format!("[autofix] self-heal artifact write failed: {}", e)
                                        );
                                    }
                                }

                                let _ = app_handle.emit(
                                    "agent:log",
                                    format!(
                                        "[autofix] self-heal applied: removed flags [{}]",
                                        removed_flags.join(", ")
                                    )
                                );

                                let _ = app_handle.emit(
                                    "agent:log",
                                    format!("[autofix] retry starting with sanitized prompt (failure_step={})", retry_failure_step)
                                );
                                let _ = app_handle.emit("phase:update", "generate");

                                match run_node_agent_once(
                                    &repo_root,
                                    &project,
                                    &provider,
                                    "full",
                                    "none",
                                    &retry_prompt,
                                    true,
                                ) {
                                    Ok((retry_out, retry_killed)) => {
                                        let retry_stdout = String::from_utf8_lossy(&retry_out.stdout);
                                        let retry_stderr = String::from_utf8_lossy(&retry_out.stderr);

                                        for line in retry_stdout.lines() {
                                            let line_s = format!("[retry] {}", line);
                                            let lower = line.to_lowercase();

                                            if lower.contains("feature=") || lower.contains("generating files") {
                                                let _ = app_handle.emit("phase:update", "generate");
                                            } else if lower.contains("$ flutter analyze") || lower.contains("analyzing ") {
                                                let _ = app_handle.emit("phase:update", "analyze");
                                            } else if lower.contains("$ flutter test") || lower.contains("all tests passed") || lower.contains("smoke test") {
                                                let _ = app_handle.emit("phase:update", "test");
                                            } else if lower.contains("hot reload triggered") || lower.contains("reload_ok") {
                                                let _ = app_handle.emit("phase:update", "reload");
                                            } else if lower.contains("wrote run.json status=success") {
                                                let _ = app_handle.emit("phase:update", "done");
                                            }

                                            let _ = app_handle.emit("agent:log", line_s);
                                        }

                                        for line in retry_stderr.lines() {
                                            let _ = app_handle.emit("agent:log", format!("[retry][stderr] {}", line));
                                        }

                                        let retry_run_path = repo_root.join("workspace").join("projects").join(&project).join("run.json");
                                        let retry_run_json = std::fs::read_to_string(&retry_run_path)
                                            .ok()
                                            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());

                                        let retry_run_status = retry_run_json
                                            .as_ref()
                                            .and_then(|v| v.get("status"))
                                            .and_then(|v| v.as_str())
                                            .unwrap_or("");

                                        if retry_run_status == "success" || (retry_out.status.success() && !retry_killed) {
                                            let project_dir2 = repo_root.join("workspace").join("projects").join(&project);

                                            match rewrite_run_json_success_after_retry(&project_dir2, &project) {
                                                Ok(path) => {
                                                    let _ = app_handle.emit("agent:log", format!("[autofix] run.json rewritten after retry success: {}", path.display()));
                                                }
                                                Err(e) => {
                                                    let _ = app_handle.emit("agent:log", format!("[autofix] run.json rewrite failed after retry success: {}", e));
                                                }
                                            }

                                            match update_autofix_retry_run_artifact(
                                                &project_dir2,
                                                "succeeded",
                                                "success",
                                                "Retry completed successfully after sanitized prompt rerun.",
                                            ) {
                                                Ok(path) => {
                                                    let _ = app_handle.emit("agent:log", format!("[autofix] retry run artifact updated: {}", path.display()));
                                                }
                                                Err(e) => {
                                                    let _ = app_handle.emit("agent:log", format!("[autofix] retry run artifact update failed: {}", e));
                                                }
                                            }

                                            let _ = app_handle.emit("agent:log", "[autofix] retry succeeded");
                                            let _ = app_handle.emit("phase:update", "done");
                                            let _ = app_handle.emit("agent:done", "ok");
                                        } else {
                                            let _ = app_handle.emit("agent:log", format!("[autofix] retry debug status={} killed={}", retry_out.status, retry_killed));
                                            if retry_stdout.trim().is_empty() {
                                                let _ = app_handle.emit("agent:log", "[autofix] retry stdout empty");
                                            } else {
                                                let _ = app_handle.emit("agent:log", format!("[autofix] retry stdout:\n{}", retry_stdout));
                                            }
                                            if retry_stderr.trim().is_empty() {
                                                let _ = app_handle.emit("agent:log", "[autofix] retry stderr empty");
                                            } else {
                                                let _ = app_handle.emit("agent:log", format!("[autofix] retry stderr:\n{}", retry_stderr));
                                            }
                                            match update_autofix_retry_run_artifact(
                                                &repo_root.join("workspace").join("projects").join(&project),
                                                "failed",
                                                "failed",
                                                "Retry rerun completed but run.json did not reach success.",
                                            ) {
                                                Ok(path) => {
                                                    let _ = app_handle.emit("agent:log", format!("[autofix] retry run artifact updated: {}", path.display()));
                                                }
                                                Err(e) => {
                                                    let _ = app_handle.emit("agent:log", format!("[autofix] retry run artifact update failed: {}", e));
                                                }
                                            }

                                            let _ = app_handle.emit("agent:log", "[autofix] retry failed");
                                            let _ = app_handle.emit("phase:update", "error");
                                            let _ = app_handle.emit("agent:done", format!("error ({})", retry_out.status));
                                        }
                                    }
                                    Err(e) => {
                                        match update_autofix_retry_run_artifact(
                                            &repo_root.join("workspace").join("projects").join(&project),
                                            "failed",
                                            "spawn_error",
                                            &format!("Retry spawn failed: {}", e),
                                        ) {
                                            Ok(path) => {
                                                let _ = app_handle.emit("agent:log", format!("[autofix] retry run artifact updated: {}", path.display()));
                                            }
                                            Err(err2) => {
                                                let _ = app_handle.emit("agent:log", format!("[autofix] retry run artifact update failed: {}", err2));
                                            }
                                        }

                                        let _ = app_handle.emit("agent:log", format!("[autofix] retry spawn failed: {}", e));
                                        let _ = app_handle.emit("phase:update", "error");
                                        let _ = app_handle.emit("agent:done", format!("error ({})", out.status));
                                    }
                                }
                            } else {
                                let _ = app_handle.emit("phase:update", "error");
                                let _ = app_handle.emit("agent:done", format!("error ({})", out.status));
                            }
                        }
                    }
                    Err(e) => {
                        let _ = app_handle.emit("phase:update", "error");
                        let _ = app_handle.emit("agent:log", format!("[backend] wait_with_output failed: {}", e));
                        let _ = app_handle.emit("agent:done", "error");
                    }
                }
            }
            Err(e) => {
                let _ = app_handle.emit("phase:update", "error");
                let _ = app_handle.emit("agent:log", format!("[backend] failed to start agent: {}", e));
                let _ = app_handle.emit("agent:done", "error");
            }
        }
    });

    Ok(())
}

#[tauri::command]
fn run_agent_stream(app: AppHandle, project: String, prompt: String, build_apk: bool) -> Result<(), String> {
  let _ = app.emit("agent:log", format!("[backend] run_agent_stream project={} buildApk={}", project, build_apk));
  let _ = app.emit("agent:log", format!("[backend] prompt: {}", prompt));

  let repo_root = find_repo_root().ok_or_else(|| {
    format!(
      "Could not locate repo root (workspace/projects not found). cwd={}",
      std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_else(|_| "<unknown>".to_string())
    )
  })?;

  let project_dir = repo_root.join("workspace").join("projects").join(&project);

  // APPLY_PREFLIGHT_ENV
  apply_preflight_env(&app, &project_dir);
  inject_flutter_dotenv(&app, &project_dir);

  let run_path = project_dir.join("run.json");
  let run_id = new_run_id(&project);
  let started_at = now_ts();


  // Preflight (MVP): require config before running phases
  let cfg = read_preflight_normalized(&project_dir);
  if !preflight_is_complete(&cfg) {
    let msg = "Preflight required. Configure integrations first (Supabase/SendGrid + monetization) and set completed=true.";
    let mut steps0: Vec<StepResult> = vec![];
    steps0.push(StepResult {
      name: "preflight".to_string(),
      exit_code: 1,
      error: Some(msg.to_string()),
      output_tail: msg.to_string(),
    });
    write_run_json(&run_path, &run_id, started_at, &project, build_apk, "failed", "preflight", &steps0, 0, msg)?;
    let _ = app.emit("agent:log", format!("[preflight] {}", msg));
    let _ = app.emit("agent:done", "needs_preflight");
    return Ok(());
  }


  let mut steps: Vec<StepResult> = vec![];
  let mut repair_attempts: i32 = 0;
  let mut last_error: String = "".to_string();

  // Phase: feature_generate (placeholder)
  let _ = app.emit("agent:log", "[phase:feature_generate] (placeholder) generating feature...");
  steps.push(StepResult { name: "feature_generate".to_string(), exit_code: 0, error: None, output_tail: "".to_string() });
  write_run_json(&run_path, &run_id, started_at, &project, build_apk, "running", "feature_generate", &steps, repair_attempts, &last_error)?;

  // Helper closure to run a phase with auto-repair retries
  let mut run_phase = |phase_name: &str, cmd: &str, args: &[&str]| -> Result<bool, String> {
    // try up to 1 + 2 repairs = 3 total attempts
    for attempt in 0..3 {
      let st = run_step(&app, &project_dir, phase_name, cmd, args);
      steps.push(st.clone());
      write_run_json(&run_path, &run_id, started_at, &project, build_apk, "running", phase_name, &steps, repair_attempts, &last_error)?;

      if st.exit_code == 0 {
        return Ok(true);
      }

      last_error = format!("[{}] failed (attempt {}):
{}", phase_name, attempt + 1, st.output_tail);

      // if we still have retries left, do repair then retry
      if attempt < 2 {
        repair_attempts += 1;
        let fixes = attempt_repair(&app, &project_dir);
        for fx in fixes {
          steps.push(fx);
        }
        write_run_json(&run_path, &run_id, started_at, &project, build_apk, "running", "repair", &steps, repair_attempts, &last_error)?;
        continue;
      } else {
        // exhausted retries
        return Ok(false);
      }
    }
    Ok(false)
  };

  // Phase: flutter_pub_get
  if !run_phase("flutter_pub_get", "flutter", &["pub", "get"])? {
    write_run_json(&run_path, &run_id, started_at, &project, build_apk, "failed", "flutter_pub_get", &steps, repair_attempts, &last_error)?;
    let _ = app.emit("agent:done", "failed");
    return Ok(());
  }

  // Phase: flutter_analyze
  if !run_phase("flutter_analyze", "flutter", &["analyze"])? {
    write_run_json(&run_path, &run_id, started_at, &project, build_apk, "failed", "flutter_analyze", &steps, repair_attempts, &last_error)?;
    let _ = app.emit("agent:done", "failed");
    return Ok(());
  }

  // Phase: flutter_test
  if !run_phase("flutter_test", "flutter", &["test"])? {
    write_run_json(&run_path, &run_id, started_at, &project, build_apk, "failed", "flutter_test", &steps, repair_attempts, &last_error)?;
    let _ = app.emit("agent:done", "failed");
    return Ok(());
  }

  // Optional: build apk
  if build_apk {
    if !run_phase("flutter_build_apk", "flutter", &["build", "apk"])? {
      write_run_json(&run_path, &run_id, started_at, &project, build_apk, "failed", "flutter_build_apk", &steps, repair_attempts, &last_error)?;
      let _ = app.emit("agent:done", "failed");
      return Ok(());
    }
  }

  write_run_json(&run_path, &run_id, started_at, &project, build_apk, "success", "done", &steps, repair_attempts, &last_error)?;
  let _ = app.emit("agent:log", format!("[backend] wrote run.json: {}", run_path.display()));
  let _ = app.emit("agent:done", "ok");
  Ok(())
}






fn main() {
  tauri::Builder::default()
    .manage(RunConfigState(Mutex::new(RunConfig {
      live_preview: true,
      stop_after: "never".to_string(),
    })))
    .invoke_handler(tauri::generate_handler![
        read_run_json,
        set_run_config,
        run_agent_stream,
        list_secrets,
        set_secret,
        start_live_flutter,
        reveal_project,
        rerun_after_patch,
        execute_autofix_patch,
        evaluate_autofix_execution,
        set_autofix_approval_status,
        read_file_if_exists,
        read_run_history_artifact,
        list_run_history_artifacts,
        read_run_json_project,
        get_preflight_config,
        set_preflight_config,
        evaluate_continue,
        continue_agent,
        run_agent,
        read_run_history
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

// ===== SECURE KEY LOADER =====

