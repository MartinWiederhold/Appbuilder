#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};

#[derive(Default)]
struct RunConfig {
  live_preview: bool,
  stop_after: String,
}
struct RunConfigState(Mutex<RunConfig>);

// --- Commands used by the frontend (src/App.tsx) ---
fn find_repo_root() -> Option<std::path::PathBuf> {
  let mut dir = std::env::current_dir().ok()?;

  loop {
    // repo root is the directory that contains workspace/projects
    if dir.join("workspace").join("projects").is_dir() {
      return Some(dir);
    }
    if !dir.pop() { break; }
  }
  None
}

#[tauri::command]
fn read_run_json_project(project: String) -> Result<String, String> {
  let cwd = std::env::current_dir().map_err(|e| format!("current_dir: {}", e))?;

  // If we're inside ".../apps/...", repo root is the parent of "apps"
  let mut dir = cwd.clone();
  let repo_root = loop {
    if dir.file_name().and_then(|x| x.to_str()) == Some("apps") {
      let parent = dir.parent().ok_or("apps has no parent")?.to_path_buf();
      break parent;
    }
    if !dir.pop() {
      return Err(format!("Could not locate repo root (no 'apps' folder in parents). cwd={}", cwd.display()));
    }
  };

  let path = repo_root.join("workspace").join("projects").join(&project).join("run.json");

  println!("[backend] run.json path: {}", path.display());std::fs::read_to_string(&path).map_err(|e| format!(
    "read_run_json_project failed: cwd={} repo_root={} path={} err={}",
    cwd.display(), repo_root.display(), path.display(), e
  ))
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
fn start_live_flutter(app: AppHandle) -> Result<(), String> {
  // just notify UI (so it doesn't look broken)
  let _ = app.emit("agent:log", "[backend] start_live_flutter called (noop)");
  Ok(())
}

#[tauri::command]
fn run_agent_stream(app: AppHandle, project: String, prompt: String, build_apk: bool) -> Result<(), String> {
  // Minimal "fake agent" to prove pipeline works: emits logs + done event.
  let _ = app.emit("agent:log", format!("[backend] run_agent_stream project={project} buildApk={build_apk}"));
  let _ = app.emit("agent:log", format!("[backend] prompt: {prompt}"));
  println!("[backend] wrote run.json (if agent produced it)");
  
  // HARDEN: ensure run.json gets a fresh finishedAt even if the agent didn't update it
  if let Ok(mut txt) = std::fs::read_to_string(&path) {
    if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&txt) {
      // set finishedAt = now (UTC ISO-like)
      let now = chrono::Utc::now().to_rfc3339();
      v["finishedAt"] = serde_json::Value::String(now);
      if let Ok(out) = serde_json::to_string_pretty(&v) {
        let _ = std::fs::write(&path, out);
        println!("[backend] hardened run.json finishedAt update: {}", path.display());
      }
    }
  }

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
