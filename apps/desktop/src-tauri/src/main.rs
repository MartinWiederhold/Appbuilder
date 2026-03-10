#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::{AppHandle, Emitter};
use serde_json::json;
use serde_json::Value;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

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

let _ = app_handle.emit("agent:log", "[autofix] fix proposal received");
                            let _ = app_handle.emit("agent:log", proposal);

                            let _ = app_handle.emit("phase:update", "error");
                            let _ = app_handle.emit("agent:done", format!("error ({})", out.status));
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
        read_run_json_project,
        get_preflight_config,
        set_preflight_config,
        run_agent,
        read_run_history
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

// ===== SECURE KEY LOADER =====

