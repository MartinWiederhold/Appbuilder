#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{fs, path::PathBuf, process::Stdio};
use tauri::{Emitter, Window};

fn repo_root() -> PathBuf {
  // .../apps/desktop/src-tauri
  let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
  // -> .../apps/desktop
  let desktop = manifest.parent().unwrap();
  // -> .../apps
  let apps = desktop.parent().unwrap();
  // -> repo root
  apps.parent().unwrap().to_path_buf()
}

#[tauri::command]
fn list_projects() -> Vec<String> {
  let root = repo_root().join("workspace/projects");
  fs::read_dir(root)
    .map(|rd| {
      let mut v: Vec<String> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
      v.sort();
      v
    })
    .unwrap_or_default()
}

#[tauri::command]
async fn run_agent_stream(window: Window, project: String, prompt: String) -> Result<(), String> {
  let root = repo_root();
  let agent = root.join("packages/agent/src/cli.mjs");

  let mut cmd = tokio::process::Command::new("node");
  cmd.current_dir(&root)
    .arg(agent)
    .arg("--project").arg(project)
    .arg("--prompt").arg(prompt)
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

  let mut child = cmd.spawn().map_err(|e| format!("spawn_error={e}"))?;
  let stdout = child.stdout.take().ok_or("missing_stdout")?;
  let stderr = child.stderr.take().ok_or("missing_stderr")?;

  let w_out = window.clone();
  tokio::spawn(async move {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
      let _ = w_out.emit("agent:log", line);
    }
  });

  let w_err = window.clone();
  tokio::spawn(async move {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
      let _ = w_err.emit("agent:log", line);
    }
  });

  tokio::spawn(async move {
    let ok = child.wait().await.map(|s| s.success()).unwrap_or(false);
    let _ = window.emit("agent:done", if ok { "success" } else { "failed" });
  });

  Ok(())
}

fn main() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![run_agent_stream, list_projects])
    .run(tauri::generate_context!())
    .expect("error while running tauri app");
}
