#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use serde_json::json;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

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

#[derive(Clone)]
struct StepResult {
  name: String,
  exit_code: i32,
  error: Option<String>,
}

fn write_run_json(run_path: &std::path::Path, project: &str, build_apk: bool, status: &str, phase: &str, steps: &Vec<StepResult>) -> Result<(), String> {
  let steps_val = steps.iter().map(|st| {
    json!({
      "name": st.name,
      "exitCode": st.exit_code,
      "error": st.error.clone().unwrap_or_default()
    })
  }).collect::<Vec<_>>();

  let exit_code = if status == "running" || status == "success" { 0 } else { 1 };

  let payload = json!({
    "project": project,
    "status": status,
    "exitCode": exit_code,
    "buildApk": build_apk,
    "phase": phase,
    "steps": steps_val
  });

  if let Some(parent) = run_path.parent() {
    let _ = std::fs::create_dir_all(parent);
  }
  std::fs::write(run_path, serde_json::to_string_pretty(&payload).unwrap())
    .map_err(|e| format!("{}: {}", run_path.display(), e))?;
  Ok(())
}

fn run_step(app: &tauri::AppHandle, cwd: &std::path::Path, name: &str, cmd: &str, args: &[&str]) -> StepResult {
  let _ = app.emit("agent:log", format!("[phase:{}] $ {} {}", name, cmd, args.join(" ")));

  let mut child = match Command::new(cmd)
      .current_dir(cwd)
      .args(args)
      .stdout(Stdio::piped())
      .stderr(Stdio::piped())
      .spawn() {
        Ok(c) => c,
        Err(e) => {
          return StepResult { name: name.to_string(), exit_code: 1, error: Some(format!("spawn failed: {}", e)) };
        }
      };

  let stdout = child.stdout.take();
  let stderr = child.stderr.take();

  if let Some(out) = stdout {
    let app2 = app.clone();
    std::thread::spawn(move || {
      let reader = BufReader::new(out);
      for line in reader.lines().flatten() {
        let _ = app2.emit("agent:log", line);
      }
    });
  }

  if let Some(err) = stderr {
    let app2 = app.clone();
    std::thread::spawn(move || {
      let reader = BufReader::new(err);
      for line in reader.lines().flatten() {
        let _ = app2.emit("agent:log", line);
      }
    });
  }

  match child.wait() {
    Ok(st) => {
      let code = st.code().unwrap_or(1);
      StepResult {
        name: name.to_string(),
        exit_code: code,
        error: if code == 0 { None } else { Some("command failed".to_string()) }
      }
    }
    Err(e) => StepResult { name: name.to_string(), exit_code: 1, error: Some(format!("wait failed: {}", e)) },
  }
}



#[tauri::command]
fn read_run_json_project(project: String) -> Result<String, String> {
  // Find repo root by walking up until we see workspace/projects
  let mut dir = std::env::current_dir().map_err(|e| e.to_string())?;
  loop {
    if dir.join("workspace").join("projects").is_dir() {
      break;
    }
    if !dir.pop() {
      return Err(format!(
        "Could not locate repo root (workspace/projects not found). cwd={}",
        std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_else(|_| "<unknown>".to_string())
      ));
    }
  }

  let path = dir.join("workspace").join("projects").join(&project).join("run.json");
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
  let run_path = project_dir.join("run.json");

  let mut steps: Vec<StepResult> = vec![];

  // Phase: feature_generate (placeholder for now)
  let _ = app.emit("agent:log", "[phase:feature_generate] (placeholder) generating feature...");
  steps.push(StepResult { name: "feature_generate".to_string(), exit_code: 0, error: None });
  write_run_json(&run_path, &project, build_apk, "running", "feature_generate", &steps)?;

  // Phase: flutter_pub_get
  let st = run_step(&app, &project_dir, "flutter_pub_get", "flutter", &["pub", "get"]);
  steps.push(st.clone());
  write_run_json(&run_path, &project, build_apk, "running", "flutter_pub_get", &steps)?;
  if st.exit_code != 0 {
    write_run_json(&run_path, &project, build_apk, "failed", "flutter_pub_get", &steps)?;
    let _ = app.emit("agent:done", "failed");
    return Ok(());
  }

  // Phase: flutter_analyze
  let st = run_step(&app, &project_dir, "flutter_analyze", "flutter", &["analyze"]);
  steps.push(st.clone());
  write_run_json(&run_path, &project, build_apk, "running", "flutter_analyze", &steps)?;
  if st.exit_code != 0 {
    write_run_json(&run_path, &project, build_apk, "failed", "flutter_analyze", &steps)?;
    let _ = app.emit("agent:done", "failed");
    return Ok(());
  }

  // Phase: flutter_test
  let st = run_step(&app, &project_dir, "flutter_test", "flutter", &["test"]);
  steps.push(st.clone());
  write_run_json(&run_path, &project, build_apk, "running", "flutter_test", &steps)?;
  if st.exit_code != 0 {
    write_run_json(&run_path, &project, build_apk, "failed", "flutter_test", &steps)?;
    let _ = app.emit("agent:done", "failed");
    return Ok(());
  }

  // Optional: build apk
  if build_apk {
    let st = run_step(&app, &project_dir, "flutter_build_apk", "flutter", &["build", "apk"]);
    steps.push(st.clone());
    write_run_json(&run_path, &project, build_apk, "running", "flutter_build_apk", &steps)?;
    if st.exit_code != 0 {
      write_run_json(&run_path, &project, build_apk, "failed", "flutter_build_apk", &steps)?;
      let _ = app.emit("agent:done", "failed");
      return Ok(());
    }
  }

  write_run_json(&run_path, &project, build_apk, "success", "done", &steps)?;
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
      start_live_flutter,
      reveal_project,
    read_run_json_project])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
