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

export function deriveBmadPhase(run: RunJson | null): string {
  if (!run) return "idle";

  const step = lastStepName(run);

  if (run.status === "failed") return "failed";

  switch (step) {
    case "feature_generate":
      return "generate";
    case "flutter_pub_get":
      return "pub_get";
    case "flutter_analyze":
      return "analyze";
    case "flutter_test":
      return "flutter_test";
    default:
      break;
  }

  if (run.status === "success") return "success";
  if (run.status === "failed") return "failed";
  return "idle";
}

export function phaseLabel(phase: string): string {
  switch (phase) {
    case "idle":
      return "Idle";
    case "generate":
      return "Generating";
    case "pub_get":
      return "Pub Get";
    case "analyze":
      return "Analyze";
    case "flutter_test":
      return "Test";
    case "success":
      return "Done";
    case "failed":
      return "Failed";
    default:
      return phase;
  }
}
