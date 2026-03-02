export type RunJson = {
  status?: string;
  exitCode?: number;
  lastStep?: string;
  started?: string;
  finished?: string;
};

export function deriveBmadPhase(run: RunJson | null, running: boolean): string {
  if (running) return "running";
  if (!run) return "idle";

  // Strong signals first
  const status = String(run.status || "").toLowerCase();
  const exitCode = typeof run.exitCode === "number" ? run.exitCode : 0;

  if (status === "success" && exitCode === 0) return "success";
  if (status === "error" || exitCode > 0) return "error";

  const step = (run.lastStep || "").trim();
  if (!step) return status ? status : "idle";

  // "flutter_test (exit=0)" -> "flutter_test"
  return step.split(" ")[0].trim();
}
