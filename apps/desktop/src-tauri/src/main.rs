#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::process::Stdio;
use tauri::{Emitter, Window};

#[tauri::command]
async fn run_agent_stream(window: Window, project: String, prompt: String) -> Result<(), String> {
  // CARGO_MANIFEST_DIR points to .../apps/desktop/src-tauri
  // Repo root is 3 levels up: src-tauri -> desktop -> apps -> repo_root
  let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
  let repo_root = manifest_dir
    .parent().and_then(|p| p.parent()).and_then(|p| p.parent())
    .ok_or("could_not_resolve_repo_root")?
    .to_path_buf();

  let agent_path = repo_root.join("packages/agent/src/cli.mjs");

  let mut cmd = tokio::process::Command::new("node");
  cmd.current_dir(&repo_root);
  cmd.arg(agent_path);
  cmd.arg("--project").arg(project);
  cmd.arg("--prompt").arg(prompt);

  cmd.stdout(Stdio::piped());
  cmd.stderr(Stdio::piped());

  let mut child = cmd.spawn().map_err(|e| format!("spawn_error={e}"))?;

  let stdout = child.stdout.take().ok_or("missing_stdout")?;
  let stderr = child.stderr.take().ok_or("missing_stderr")?;

  let win_out = window.clone();
  let win_err = window.clone();

  tokio::spawn(async move {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
      let _ = win_out.emit("agent:log", line);
    }
  });

  tokio::spawn(async move {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
      let _ = win_err.emit("agent:log", line);
    }
  });

  tokio::spawn(async move {
    match child.wait().await {
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
