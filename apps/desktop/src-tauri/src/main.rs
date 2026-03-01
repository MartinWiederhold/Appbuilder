#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{fs, path::PathBuf, process::Stdio};
use tauri::{Emitter, Window};

fn repo_root() -> PathBuf {
  let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR")); // .../apps/desktop/src-tauri
  let desktop = manifest.parent().unwrap();                 // .../apps/desktop
  let apps = desktop.parent().unwrap();                     // .../apps
  apps.parent().unwrap().to_path_buf()                      // repo root
}

#[derive(serde::Serialize)]
struct ProjectInfo {
  name: String,
  last_status: String,        // "success" | "failed" | "never"
  finished_at: Option<String> // ISO timestamp
}


#[derive(serde::Deserialize)]
struct RunConfig {
  live_preview: bool,
  stop_after: String, // "never" | "generate"
}

#[tauri::command]
fn set_run_config(cfg: RunConfig) -> Result<(), String> {
  std::env::set_var("LIVE_PREVIEW", if cfg.live_preview { "1" } else { "0" });
  std::env::set_var("STOP_AFTER", cfg.stop_after);
  Ok(())
}


#[tauri::command]
fn list_projects_with_status() -> Vec<ProjectInfo> {
  let root = repo_root().join("workspace/projects");
  let mut out: Vec<ProjectInfo> = Vec::new();

  let rd = match fs::read_dir(root) {
    Ok(v) => v,
    Err(_) => return out,
  };

  for e in rd.flatten() {
    let p = e.path();
    if !p.is_dir() { continue; }
    let name = e.file_name().to_string_lossy().to_string();

    let run_json = p.join("run.json");
    if let Ok(s) = fs::read_to_string(run_json) {
      if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
        let status = v.get("status").and_then(|x| x.as_str()).unwrap_or("never").to_string();
        let finished_at = v.get("finishedAt").and_then(|x| x.as_str()).map(|x| x.to_string());
        out.push(ProjectInfo { name, last_status: status, finished_at });
        continue;
      }
    }

    out.push(ProjectInfo { name, last_status: "never".to_string(), finished_at: None });
  }

  out.sort_by(|a, b| a.name.cmp(&b.name));
  out
}

#[tauri::command]
async fn run_agent_stream(window: Window, project: String, prompt: String, build_apk: bool) -> Result<(), String> {
  eprintln!("[dbg] run_agent_stream INVOKED");
  let root = repo_root();
  let agent = root.join("packages/agent/src/cli.mjs");

  let mut cmd = tokio::process::Command::new("node");
  cmd.current_dir(&root)
    .arg(agent)
    .arg("--project").arg(project)
    .arg("--prompt").arg(prompt)
    .arg("--build_apk").arg(if build_apk { "1" } else { "0" })
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
    start_live_preview();
    let _ = window.emit("agent:done", if ok { "success" } else { "failed" });
  });

  Ok(())
}


#[tauri::command]
fn git_status_project(project: String) -> Result<String, String> {
  use std::process::Command;

  let root = repo_root();
  let project_path = root.join("workspace").join("projects").join(&project);

  // git runs at repo root; filter output to this project folder
  let out = Command::new("git")
    .arg("-C").arg(&root)
    .arg("status").arg("--porcelain")
    .arg("--")
    .arg(&project_path)
    .output()
    .map_err(|e| format!("git_status_spawn_error={e}"))?;

  Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[tauri::command]
fn git_diff_project_v2(project: String) -> Result<String, String> {
  use std::process::Command;

  let root = repo_root();
  let rel = format!("workspace/projects/{}", project);

  let out = Command::new("git")
    .arg("-C").arg(&root)
    .arg("diff")
    .arg("--").arg(&rel)
    .output()
    .map_err(|e| format!("git_diff_spawn_error={e}"))?;

  Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

#[tauri::command]
fn reveal_project(project: String) -> Result<(), String> {
  let root = repo_root();
  let dir = root.join("workspace/projects").join(project);

  std::process::Command::new("open")
    .arg(dir)
    .spawn()
    .map_err(|e| format!("open_spawn_error={e}"))?;

  Ok(())
}




#[tauri::command]

fn find_repo_root() -> Result<std::path::PathBuf, String> {
  // 1) walk up from current_dir
  if let Ok(mut dir) = std::env::current_dir() {
    for _ in 0..12 {
      if dir.join("workspace").join("projects").exists() {
        return Ok(dir);
      }
      if !dir.pop() { break; }
    }
  }

  // 2) walk up from current_exe (works well for Tauri dev)
  if let Ok(mut exe) = std::env::current_exe() {
    // drop filename
    exe.pop();
    for _ in 0..15 {
      if exe.join("workspace").join("projects").exists() {
        return Ok(exe);
      }
      if !exe.pop() { break; }
    }
  }

  Err("Could not locate repo root containing workspace/projects".into())
}

fn run_json_path(project: &str) -> Result<std::path::PathBuf, String> {
  use std::path::PathBuf;

  fn is_candidate(dir: &PathBuf) -> bool {
    dir.join("workspace").join("projects").is_dir()
  }

  fn pick_best_root(mut dir: PathBuf) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    for _ in 0..30 {
      if is_candidate(&dir) {
        candidates.push(dir.clone());
      }
      if !dir.pop() { break; }
    }

    if candidates.is_empty() {
      return None;
    }

    // Prefer the one that looks like the real repo root (has .git)
    for c in &candidates {
      if c.join(".git").is_dir() {
        return Some(c.clone());
      }
    }

    // Otherwise pick the top-most candidate (last one while walking up)
    Some(candidates.last().unwrap().clone())
  }

  // Try from current executable directory
  if let Ok(mut exe) = std::env::current_exe() {
    exe.pop();
    if let Some(root) = pick_best_root(exe) {
      return Ok(root.join("workspace").join("projects").join(project).join("run.json"));
    }
  }

  // Fallback: try from current working directory
  if let Ok(cwd) = std::env::current_dir() {
    if let Some(root) = pick_best_root(cwd) {
      return Ok(root.join("workspace").join("projects").join(project).join("run.json"));
    }
  }

  Err("Could not locate repo root (workspace/projects)".to_string())
}

#[tauri::command]

fn read_run_json(project: String) -> Result<String, String> {
  let path = run_json_path(&project)?;
  // optional debug:
  eprintln!("[tauri] read_run_json: {}", path.display());

  std::fs::read_to_string(&path).map_err(|e| format!("read {} failed: {}", path.display(), e))
}

#[tauri::command]
fn clear_run_json(project: String) -> Result<(), String> {
  let path = run_json_path(&project)?;
  // optional debug:
  eprintln!("[tauri] clear_run_json: {}", path.display());

  if path.exists() {
    std::fs::remove_file(&path).map_err(|e| format!("remove {} failed: {}", path.display(), e))?;
  }
  Ok(())
}



// AUTO_LIVE_PREVIEW
fn start_live_preview() {
    use std::process::Command;

    // Gate: only run when LIVE_PREVIEW=1
    if std::env::var("LIVE_PREVIEW").ok().as_deref() != Some("1") {
        return;
    }

    // Gate: stop after phase (default: never)
    let stop_after = std::env::var("STOP_AFTER").unwrap_or_else(|_| "never".to_string());
    if stop_after != "never" {
        // If user wants to stop after some phase, we do NOT auto-start/reload preview.
        return;
    }

// Startet/Restartet Flutter Live Preview Script (background)
    println!("[live_preview] start_live_preview() called");
    let _ = Command::new("bash")
        .arg("-lc")
        .arg("cd ~/dev/flutter-builder && ./scripts/run_live_flutter.sh")
        .spawn();
}

#[tauri::command]
async fn start_live_flutter() -> Result<(), String> {
  let root = repo_root();
  let script = root.join("scripts/run_live_flutter.sh");

  std::process::Command::new("bash")
    .arg(script)
    .current_dir(&root)
    .spawn()
    .map_err(|e| format!("start_live_flutter failed: {e}"))?;

  Ok(())
}


fn main() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
    
  run_agent_stream,
  list_projects_with_status,
  read_run_json,
  clear_run_json,
  set_run_config,
  git_status_project,
  git_diff_project_v2,
  reveal_project,
  start_live_flutter

])
    .run(tauri::generate_context!())
    .expect("error while running tauri app");
}
