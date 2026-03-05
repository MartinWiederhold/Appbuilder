export type RunStep = {
  name?: string;
  exitCode?: number;
};

export type RunJson = {
  status?: string;
  lastStep?: string;
  exitCode?: number;
  steps?: RunStep[];
};

function lastStepName(run: RunJson): string | null {
  if (run.lastStep) return run.lastStep;
  const steps = run.steps ?? [];
  const last = steps.length ? steps[steps.length - 1] : null;
  return last?.name ?? null;
}

export function deriveBmadPhase(run: RunJson | null, running: boolean): string {
  if (running) return "running";
  if (!run) return "idle";

  const step = lastStepName(run);
  if (step) return String(step).split(" ")[0];

  if (run.status) return String(run.status);
  return "idle";
}
