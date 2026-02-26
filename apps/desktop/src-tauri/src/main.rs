#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Command;

#[tauri::command]
fn run_agent(project_name: String, prompt: String) -> Result<String, String> {
  let output = Command::new("node")
    .arg("../../../packages/agent/index.js")
    .arg(project_name)
    .arg(prompt)
    .output()
    .map_err(|e| format!("Failed to run agent: {e}"))?;

  let stdout = String::from_utf8_lossy(&output.stdout).to_string();
  let stderr = String::from_utf8_lossy(&output.stderr).to_string();

  if !output.status.success() {
    return Err(format!("Agent error.\nSTDOUT:\n{stdout}\nSTDERR:\n{stderr}"));
  }

  Ok(stdout)
}

fn main() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![run_agent])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
