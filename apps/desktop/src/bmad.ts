export type RunJson = {
  status?: string;
  lastStep?: string;
  finished?: string;
};

export function deriveBmadPhase(run: RunJson | null, running: boolean): string {
  if (running) return "running";
  if (!run) return "idle";

  if (run.lastStep) {
    return run.lastStep.split(" ")[0];
  }

  if (run.status) {
    return run.status;
  }

  return "idle";
}
