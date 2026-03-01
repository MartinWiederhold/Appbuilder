#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::{AppHandle, Emitter};

#[derive(Default)]
struct RunConfig {
  live_preview: bool,
  stop_after: String,
}
struct RunConfigState(Mutex<RunConfig>);

// --- Commands used by the frontend (src/App.tsx) ---

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
      reveal_project
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
