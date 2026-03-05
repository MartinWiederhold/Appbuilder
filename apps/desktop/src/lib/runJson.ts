import { invoke } from "@tauri-apps/api/core";

export type RunJson = any;

export async function readRunJson(absPath: string): Promise<RunJson | null> {
  try {
    const txt = await invoke<string>("read_run_json", { absPath });
    return JSON.parse(txt);
  } catch (e) {
    console.error("[runJson] read failed", e);
    return null;
  }
}
