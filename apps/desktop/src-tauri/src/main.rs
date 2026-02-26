#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::Emitter;
use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};

#[tauri::command]
fn run_agent_stream(window: tauri::Window, project_name: String, prompt: String) -> Result<(), String> {
  let mut child = Command::new("node")
    .arg("../../../packages/agent/index.js")
    .arg(project_name)
    .arg(prompt)
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|e| format!("Failed to spawn agent: {e}"))?;

  let stdout = child.stdout.take().ok_or("Failed to capture stdout")?;
  let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;

  let win_out = window.clone();
  std::thread::spawn(move || {
    let reader = BufReader::new(stdout);
    for line in reader.lines().flatten() {
      let _ = win_out.emit("agent:log", line);
    }
  });

  let win_err = window.clone();
  std::thread::spawn(move || {
    let reader = BufReader::new(stderr);
    for line in reader.lines().flatten() {
      let _ = win_err.emit("agent:log", format!("STDERR: {line}"));
    }
  });

  std::thread::spawn(move || {
    let status = child.wait();
    match status {
      Ok(s) if s.success() => {
        let _ = window.emit("agent:done", "success");
      }
      Ok(s) => {
        let _ = window.emit("agent:done", format!("exit_code={:?}", s.code()));
      }
      Err(e) => {
        let _ = window.emit("agent:done", format!("wait_error={e}"));
      }
    }
  });

  Ok(())
}

fn main() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![run_agent_stream])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
