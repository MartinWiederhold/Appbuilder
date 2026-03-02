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

  const step = (run.lastStep || "").trim();
  if (!step) return run.status ? String(run.status) : "idle";

  // normalize e.g. "flutter_test (exit=0)" -> "flutter_test"
  return step.split(" ")[0].trim();
}
