import { useEffect, useMemo, useState } from "react";
import "./App.css";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

const isE2E = typeof window !== "undefined" && new URLSearchParams(window.location.search).get("e2e") === "1";

async function readJsonFileIfExists(path: string) {
  const res = await fetch(`/__e2e__/file?path=${encodeURIComponent(path)}`);
  if (!res.ok) return null;
  return await res.json();
}

async function invokeCommand<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isE2E) {
    return await invoke<T>(cmd, args);
  }

  const project = String(args?.project ?? "todo_flutter");
  const projectRoot = `workspace/projects/${project}`;

  if (cmd === "read_current_run") {
    return (await readJsonFileIfExists(`${projectRoot}/run.json`)) as T;
  }

  if (cmd === "read_file_if_exists") {
    const relPath = String(args?.path ?? "");
    const artifactPath = `${projectRoot}/.builder/${relPath}`;
    const res = await fetch(`/__e2e__/text?path=${encodeURIComponent(artifactPath)}`);
    if (!res.ok) return "" as T;
    return (await res.text()) as T;
  }

  if (cmd === "list_secrets") {
    return ["OPENAI_API_KEY"] as T;
  }

  if (cmd === "get_preflight_config") {
    return {
      monetization: "free",
      completed: true,
      integrations: {},
    } as T;
  }

  if (cmd === "continue_agent") {
    const rerun = await readJsonFileIfExists(`${projectRoot}/.builder/autofix.rerun.json`);
    if (!rerun || rerun.rerunStatus !== "passed") {
      throw new Error("Verified gate blocked: rerunStatus is not passed");
    }
    return undefined as T;
  }

  if (cmd === "read_run_history") {
    return [] as T;
  }

  throw new Error(`[e2e] Unsupported invoke command: ${cmd}`);
}

type AgentLogPayload = string;
type Phase = "idle" | "generate" | "analyze" | "test" | "reload" | "done" | "paused" | "error";
type Provider = "openai" | "anthropic";
type RunMode = "full" | "step";
type StopAfter = "none" | "registration" | "onboarding" | "core" | "design" | "finalize";
type Monetization = "unset" | "free" | "paid";

const SESSION_KEY = "flutter_builder_session_v1";

type SessionState = {
  project: string;
  provider: Provider;
  mode: RunMode;
  stopAfter: StopAfter;
  prompt: string;
};

type SupabaseConfig = {
  enabled?: boolean;
  url?: string;
  anonKey?: string;
};

type SendgridConfig = {
  enabled?: boolean;
  apiKey?: string;
  fromEmail?: string;
};

type IntegrationsConfig = {
  supabase?: SupabaseConfig;
  sendgrid?: SendgridConfig;
};

type PreflightConfig = {
  schemaVersion?: number;
  completed?: boolean;
  monetization?: string;
  integrations?: IntegrationsConfig;
};

type RunHistoryEntry = {
  runId?: string;
  project?: string;
  status?: string;
  exitCode?: number;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  buildApk?: boolean;
};


type AutofixSelfHealState = {
  selfHealStatus?: string;
  createdAt?: string | number;
  failureStep?: string;
  removedFlags?: string[];
  originalPrompt?: string;
  sanitizedPrompt?: string;
  reason?: string;
};






type AutofixContinueState = {
  project?: string;
  continueStatus?: string;
  reason?: string;
  createdAt?: string | number;
  sourceArtifact?: string;
};

type AutofixRerunState = {
  createdAt?: string | number;
  project?: string;
  rerunStatus?: string;
  analyzeExitCode?: number;
  testExitCode?: number;
  analyzePassed?: boolean;
  testPassed?: boolean;
  reason?: string;
  sourceArtifact?: string;
};

type AutofixExecutionResultState = {
  executionResultStatus?: string;
  createdAt?: string | number;
  project?: string;
  touchedFiles?: string[];
  reason?: string;
  sourceArtifact?: string;
};

type AutofixExecutionState = {
  safeMode?: boolean;
  approvalStatus?: string;
  requiresHumanApproval?: boolean;
  executionStatus?: string;
  project?: string;
  sourceArtifact?: string;
  createdAt?: string | number;
  reason?: string;
};

type AutofixApprovalState = {
  safeMode?: boolean;
  approvalStatus?: string;
  requiresHumanApproval?: boolean;
  createdAt?: string | number;
  project?: string;
  provider?: string;
  sourceArtifact?: string;
  reason?: string;
};

type AutofixRetryRunState = {
  retryRunStatus?: string;
  finalRunStatus?: string;
  failureStep?: string | null;
  failureExitCode?: number;
  analyzeFailed?: boolean;
  testFailed?: boolean;
  notes?: string;
  removedFlags?: string[];
  runId?: string | null;
  startedAt?: string | number | null;
  updatedAt?: string | number | null;
  finishedAt?: string | number | null;
  finishedAtSource?: string | number | null;
};

type CurrentRunState = {
  runId?: string;
  project?: string;
  status?: string;
  exitCode?: number;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string;
  buildApk?: boolean;
  phase?: string;
};

function loadSession(): SessionState | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);

    return {
      project: typeof data.project === "string" ? data.project : "todo_flutter",
      provider: data.provider === "anthropic" ? "anthropic" : "openai",
      mode: data.mode === "step" ? "step" : "full",
      stopAfter:
        data.stopAfter === "registration" ||
        data.stopAfter === "onboarding" ||
        data.stopAfter === "core" ||
        data.stopAfter === "design" ||
        data.stopAfter === "finalize"
          ? data.stopAfter
          : "none",
      prompt: typeof data.prompt === "string" ? data.prompt : "",
    };
  } catch {
    return null;
  }
}

function saveSession(state: SessionState) {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(state));
  } catch {}
}

function isPreflightComplete(cfg: PreflightConfig | null): boolean {
  if (!cfg) return false;

  const completed = cfg.completed === true;
  const monetizationOk = cfg.monetization === "free" || cfg.monetization === "paid";
  const integrations =
    cfg.integrations &&
    typeof cfg.integrations === "object" &&
    !Array.isArray(cfg.integrations)
      ? cfg.integrations
      : null;

  if (!completed || !monetizationOk || !integrations) return false;

  const supabase = integrations.supabase;
  const sendgrid = integrations.sendgrid;

  const supabaseOk =
    !supabase?.enabled ||
    (!!supabase.url?.trim() && !!supabase.anonKey?.trim());

  const sendgridOk =
    !sendgrid?.enabled ||
    (!!sendgrid.apiKey?.trim() && !!sendgrid.fromEmail?.trim());

  return supabaseOk && sendgridOk;
}

function formatTs(ts?: string): string {
  if (!ts) return "-";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

function parseJsonSafe<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function isRunPossiblyActive(run: CurrentRunState | null): boolean {
  if (!run) return false;
  if (run.status === "running") return true;
  if (!run.finishedAt) return true;
  return false;
}

export default function App() {
  const initialSession = loadSession();

  const [project, setProject] = useState(initialSession?.project ?? "todo_flutter");
  const [provider, setProvider] = useState<Provider>(initialSession?.provider ?? "openai");
  const [mode, setMode] = useState<RunMode>(initialSession?.mode ?? "full");
  const [stopAfter, setStopAfter] = useState<StopAfter>(initialSession?.stopAfter ?? "none");
  const [prompt, setPrompt] = useState(
    initialSession?.prompt ?? "feature: todo_v1\ntitle: Todo Pro\nhome_title: Todo Home"
  );
  const [logs, setLogs] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [pausedAt, setPausedAt] = useState<string>("");

  const [secretNames, setSecretNames] = useState<string[]>([]);
  const [secretInput, setSecretInput] = useState("");
  const [secretBusy, setSecretBusy] = useState(false);

  const [preflightConfig, setPreflightConfig] = useState<PreflightConfig | null>(null);
  const [preflightBusy, setPreflightBusy] = useState(false);
  const [preflightSaveBusy, setPreflightSaveBusy] = useState(false);
  const [monetizationInput, setMonetizationInput] = useState<Monetization>("unset");
  const [completedInput, setCompletedInput] = useState(false);

  const [supabaseEnabled, setSupabaseEnabled] = useState(false);
  const [supabaseUrl, setSupabaseUrl] = useState("");
  const [supabaseAnonKey, setSupabaseAnonKey] = useState("");

  const [sendgridEnabled, setSendgridEnabled] = useState(false);
  const [sendgridApiKey, setSendgridApiKey] = useState("");
  const [sendgridFromEmail, setSendgridFromEmail] = useState("");

  const [runHistory, setRunHistory] = useState<RunHistoryEntry[]>([]);
  const [runHistoryBusy, setRunHistoryBusy] = useState(false);

  const [currentRun, setCurrentRun] = useState<CurrentRunState | null>(null);
  const [currentRunBusy, setCurrentRunBusy] = useState(false);
  const [runHistoryArtifacts, setRunHistoryArtifacts] = useState<string[]>([]);
  const [selectedRunHistoryArtifact, setSelectedRunHistoryArtifact] = useState<string>("");
  const [runHistoryArtifactContent, setRunHistoryArtifactContent] = useState<string>("");
  const [autofixSelfHeal, setAutofixSelfHeal] = useState<AutofixSelfHealState | null>(null);
  const [autofixRetryRun, setAutofixRetryRun] = useState<AutofixRetryRunState | null>(null);
  const [autofixBusy, setAutofixBusy] = useState(false);
  const [autofixApproval, setAutofixApproval] = useState<AutofixApprovalState | null>(null);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [autofixExecution, setAutofixExecution] = useState<AutofixExecutionState | null>(null);
  const [autofixExecutionResult, setAutofixExecutionResult] = useState<AutofixExecutionResultState | null>(null);
  const [autofixRerun, setAutofixRerun] = useState<AutofixRerunState | null>(null);
  const [autofixContinue, setAutofixContinue] = useState<AutofixContinueState | null>(null);
  const [artifactMap, setArtifactMap] = useState<Record<string, string>>({});
  const [selectedArtifact, setSelectedArtifact] = useState<string>("autofix.retry.run.json");

  const e2eParams =
    typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
  const e2eCurrentRun = e2eParams?.get("e2eCurrentRun");
  const e2eRerun = e2eParams?.get("e2eRerun");



  useEffect(() => {
    if (!isE2E) return;

    if (e2eCurrentRun === "paused") {
      setCurrentRun({
        runId: "e2e-run",
        project,
        status: "running",
        startedAt: "2026-03-12T15:00:00.000Z",
        finishedAt: null,
        phase: "paused",
        step: "human_approval",
        steps: [],
      } as CurrentRunState);
    }

    if (e2eRerun === "passed" || e2eRerun === "failed") {
      setAutofixRerun({
        project,
        rerunStatus: e2eRerun,
        analyzePassed: e2eRerun === "passed",
        testPassed: e2eRerun === "passed",
        analyzeExitCode: e2eRerun === "passed" ? 0 : 1,
        testExitCode: e2eRerun === "passed" ? 0 : 1,
        reason:
          e2eRerun === "passed"
            ? "E2E mocked rerun passed."
            : "E2E mocked rerun failed.",
        sourceArtifact: "autofix.execution.result.json",
      } as AutofixRerunState);
    }
  }, [project, e2eCurrentRun, e2eRerun]);


  const groupedRunHistoryArtifacts = useMemo(() => {
    const groups: Array<{ title: string; items: string[] }> = [];

    const continueItems = runHistoryArtifacts.filter((item) => item.includes("continue"));
    const executionItems = runHistoryArtifacts.filter(
      (item) => item.includes("execution") && !item.includes("continue")
    );
    const rerunItems = runHistoryArtifacts.filter((item) => item.includes("rerun"));
    const otherItems = runHistoryArtifacts.filter(
      (item) =>
        !continueItems.includes(item) &&
        !executionItems.includes(item) &&
        !rerunItems.includes(item)
    );

    if (continueItems.length) groups.push({ title: "Continue", items: continueItems });
    if (executionItems.length) groups.push({ title: "Execution", items: executionItems });
    if (rerunItems.length) groups.push({ title: "Rerun", items: rerunItems });
    if (otherItems.length) groups.push({ title: "Other", items: otherItems });

    return groups;
  }, [runHistoryArtifacts]);

  const logText = useMemo(() => logs.join("\n"), [logs]);

  const requiredSecretName =
    provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";

  const providerSecretPresent = secretNames.includes(requiredSecretName);
  const preflightComplete = isPreflightComplete(preflightConfig);
  const runPossiblyActive = isRunPossiblyActive(currentRun);
  const verifiedForContinue = autofixRerun?.rerunStatus === "passed";
  const effectiveCurrentRunPhase =
    isE2E && e2eCurrentRun ? e2eCurrentRun : currentRun?.phase;
  const effectiveVerifiedForContinue =
    isE2E && (e2eRerun === "passed" || e2eRerun === "failed")
      ? e2eRerun === "passed"
      : autofixRerun?.rerunStatus === "passed";

  const runLocked =
    !!currentRun &&
    currentRun.phase !== "paused" &&
    (
      currentRun.status === "running" ||
      (
        !currentRun.finishedAt &&
        currentRun.status !== "success" &&
        currentRun.status !== "error" &&
        currentRun.status !== "paused"
      )
    );

  async function refreshSecrets() {
    try {
      const names = await invokeCommand<string[]>("list_secrets");
      setSecretNames(Array.isArray(names) ? names : []);
    } catch (e) {
      setLogs((prev) => [...prev, `[ui] list_secrets failed: ${String(e)}`]);
    }
  }

  async function refreshPreflight() {
    try {
      setPreflightBusy(true);
      const cfg = await invokeCommand<PreflightConfig>("get_preflight_config", { project });
      const nextCfg = cfg ?? null;
      setPreflightConfig(nextCfg);

      setMonetizationInput(
        nextCfg?.monetization === "free" || nextCfg?.monetization === "paid"
          ? (nextCfg.monetization as Monetization)
          : "unset"
      );
      setCompletedInput(nextCfg?.completed === true);

      const supabase = nextCfg?.integrations?.supabase;
      setSupabaseEnabled(supabase?.enabled === true);
      setSupabaseUrl(typeof supabase?.url === "string" ? supabase.url : "");
      setSupabaseAnonKey(typeof supabase?.anonKey === "string" ? supabase.anonKey : "");

      const sendgrid = nextCfg?.integrations?.sendgrid;
      setSendgridEnabled(sendgrid?.enabled === true);
      setSendgridApiKey(typeof sendgrid?.apiKey === "string" ? sendgrid.apiKey : "");
      setSendgridFromEmail(typeof sendgrid?.fromEmail === "string" ? sendgrid.fromEmail : "");
    } catch (e) {
      setLogs((prev) => [...prev, `[ui] get_preflight_config failed: ${String(e)}`]);
      setPreflightConfig(null);
      setMonetizationInput("unset");
      setCompletedInput(false);
      setSupabaseEnabled(false);
      setSupabaseUrl("");
      setSupabaseAnonKey("");
      setSendgridEnabled(false);
      setSendgridApiKey("");
      setSendgridFromEmail("");
    } finally {
      setPreflightBusy(false);
    }
  }

  async function refreshRunHistory() {
    try {
      setRunHistoryBusy(true);
      const raw = await invokeCommand<string>("read_run_history", { project });
      const entries = String(raw)
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as RunHistoryEntry;
          } catch {
            return null;
          }
        })
        .filter((v): v is RunHistoryEntry => !!v)
        .reverse()
        .slice(0, 5);

      setRunHistory(entries);
    } catch (e) {
      setLogs((prev) => [...prev, `[ui] read_run_history failed: ${String(e)}`]);
      setRunHistory([]);
    } finally {
      setRunHistoryBusy(false);
    }
  }

  async function refreshCurrentRun() {
    try {
      setCurrentRunBusy(true);
      const raw = await invokeCommand<string>("read_run_json_project", { project });
      const parsed = parseJsonSafe<CurrentRunState>(String(raw));
      setCurrentRun(parsed);
    } catch {
      setCurrentRun(null);
    } finally {
      setCurrentRunBusy(false);
    }
  }

  async function openRunHistoryArtifact(fileName: string) {
    try {
      setSelectedRunHistoryArtifact(fileName);
      const content = await invokeCommand<string>("read_run_history_artifact", {
        project,
        fileName,
      });
      setRunHistoryArtifactContent(content || "");
    } catch (e) {
      setLogs((prev) => [...prev, `[ui] read_run_history_artifact failed: ${String(e)}`]);
      setRunHistoryArtifactContent("");
    }
  }

  async function refreshRunHistoryArtifacts() {
    try {
      const items = await invokeCommand<string[]>("list_run_history_artifacts", { project });
      const nextItems = Array.isArray(items) ? items : [];
      setRunHistoryArtifacts(nextItems);

      if (nextItems.length > 0) {
        const firstItem = nextItems[0];
        await openRunHistoryArtifact(firstItem);
      } else {
        setSelectedRunHistoryArtifact(null);
        setRunHistoryArtifactContent("");
      }
    } catch (e) {
      setLogs((prev) => [...prev, `[ui] list_run_history_artifacts failed: ${String(e)}`]);
      setSelectedRunHistoryArtifact(null);
      setRunHistoryArtifactContent("");
    }
  }

  async function refreshAutofixState() {
    try {
      setAutofixBusy(true);

      const artifactNames = [
        "autofix.json",
        "autofix.apply.json",
        "autofix.patch.json",
        "autofix.result.json",
        "autofix.retry.json",
        "autofix.retry.run.json",
        "autofix.selfheal.json",
        "autofix.approval.json",
        "autofix.execution.json",
        "autofix.execution.result.json",
        "autofix.rerun.json",
        "autofix.continue.json",
      ];

      const entries = await Promise.all(
        artifactNames.map(async (name) => {
          const raw = await invokeCommand<string>("read_file_if_exists", {
            project,
            relativePath: `.builder/${name}`,
          }).catch(() => "");
          return [name, String(raw || "")] as const;
        })
      );

      const nextMap: Record<string, string> = Object.fromEntries(entries);
      setArtifactMap(nextMap);

      const selfHealRaw = nextMap["autofix.selfheal.json"] ?? "";
      const retryRunRaw = nextMap["autofix.retry.run.json"] ?? "";
      const approvalRaw = nextMap["autofix.approval.json"] ?? "";
      const executionRaw = nextMap["autofix.execution.json"] ?? "";
      const executionResultRaw = nextMap["autofix.execution.result.json"] ?? "";
      const rerunRaw = nextMap["autofix.rerun.json"] ?? "";
      const continueRaw = nextMap["autofix.continue.json"] ?? "";

      setAutofixSelfHeal(selfHealRaw ? parseJsonSafe<AutofixSelfHealState>(selfHealRaw) : null);
      setAutofixRetryRun(retryRunRaw ? parseJsonSafe<AutofixRetryRunState>(retryRunRaw) : null);
      setAutofixApproval(approvalRaw ? parseJsonSafe<AutofixApprovalState>(approvalRaw) : null);
      setAutofixExecution(executionRaw ? parseJsonSafe<AutofixExecutionState>(executionRaw) : null);
      setAutofixExecutionResult(executionResultRaw ? parseJsonSafe<AutofixExecutionResultState>(executionResultRaw) : null);
      setAutofixRerun(rerunRaw ? parseJsonSafe<AutofixRerunState>(rerunRaw) : null);
      setAutofixContinue(continueRaw ? parseJsonSafe<AutofixContinueState>(continueRaw) : null);
    } catch {
      setAutofixSelfHeal(null);
      setAutofixRetryRun(null);
      setAutofixApproval(null);
      setAutofixExecution(null);
      setAutofixExecutionResult(null);
      setAutofixRerun(null);
      setAutofixContinue(null);
      setArtifactMap({});
    } finally {
      setAutofixBusy(false);
    }
  }

  async function onSetApprovalStatus(nextStatus: "approved" | "rejected") {
    try {
      setApprovalBusy(true);
      await invokeCommand("set_autofix_approval_status", {
        project,
        status: nextStatus,
      });
      setLogs((prev) => [...prev, `[ui] approval status updated -> ${nextStatus}`]);
      await refreshAutofixState();
    } catch (e) {
      setLogs((prev) => [...prev, `[ui] approval update failed: ${String(e)}`]);
    } finally {
      setApprovalBusy(false);
    }
  }

  async function onEvaluateExecution() {
    try {
      setApprovalBusy(true);
      await invokeCommand("evaluate_autofix_execution", { project });
      setLogs((prev) => [...prev, "[ui] execution gate evaluated"]);
      await refreshAutofixState();
    } catch (e) {
      setLogs((prev) => [...prev, `[ui] execution gate evaluation failed: ${String(e)}`]);
    } finally {
      setApprovalBusy(false);
    }
  }

  async function onExecuteApprovedPatch() {
    try {
      setApprovalBusy(true);
      await invokeCommand("execute_autofix_patch", { project });
      setLogs((prev) => [...prev, "[ui] controlled patch execution completed"]);
      await refreshAutofixState();
    } catch (e) {
      setLogs((prev) => [...prev, `[ui] controlled patch execution failed: ${String(e)}`]);
    } finally {
      setApprovalBusy(false);
    }
  }

  async function onRerunAfterPatch() {
    try {
      setApprovalBusy(true);
      await invokeCommand("rerun_after_patch", { project });
      setLogs((prev) => [...prev, "[ui] rerun after patch completed"]);
      await refreshAutofixState();
    } catch (e) {
      setLogs((prev) => [...prev, `[ui] rerun after patch failed: ${String(e)}`]);
    } finally {
      setApprovalBusy(false);
    }
  }

  async function onSavePreflight() {
    if (preflightSaveBusy) return;

    try {
      setPreflightSaveBusy(true);

      const nextConfig: PreflightConfig = {
        completed: completedInput,
        monetization: monetizationInput === "unset" ? "unset" : monetizationInput,
        integrations: {
          supabase: {
            enabled: supabaseEnabled,
            url: supabaseUrl.trim(),
            anonKey: supabaseAnonKey.trim(),
          },
          sendgrid: {
            enabled: sendgridEnabled,
            apiKey: sendgridApiKey.trim(),
            fromEmail: sendgridFromEmail.trim(),
          },
        },
      };

      await invokeCommand("set_preflight_config", {
        project,
        config: nextConfig,
      });

      setLogs((prev) => [
        ...prev,
        `[ui] saved preflight completed=${String(completedInput)} monetization=${monetizationInput}`,
      ]);

      await refreshPreflight();
    } catch (e) {
      setLogs((prev) => [...prev, `[ui] set_preflight_config failed: ${String(e)}`]);
    } finally {
      setPreflightSaveBusy(false);
    }
  }

  async function onSaveSecret() {
    const value = secretInput.trim();
    if (!value || secretBusy) return;

    try {
      setSecretBusy(true);
      await invokeCommand("set_secret", {
        name: requiredSecretName,
        value,
      });
      setSecretInput("");
      setLogs((prev) => [...prev, `[ui] stored secret ${requiredSecretName}`]);
      await refreshSecrets();
    } catch (e) {
      setLogs((prev) => [...prev, `[ui] set_secret failed: ${String(e)}`]);
    } finally {
      setSecretBusy(false);
    }
  }

  useEffect(() => {
    refreshSecrets();
  }, []);

  useEffect(() => {
    refreshPreflight();
    refreshRunHistory();
    refreshCurrentRun();
    refreshAutofixState();
  }, [project]);

  useEffect(() => {
    saveSession({
      project,
      provider,
      mode,
      stopAfter,
      prompt,
    });
  }, [project, provider, mode, stopAfter, prompt]);

  useEffect(() => {
    const unlistenPromises = [
      listen<AgentLogPayload>("agent:log", (event) => {
        const line = String(event.payload);
        const lower = line.toLowerCase();

        setLogs((prev) => [...prev, line]);

        if (
          lower.includes("missing openai_api_key") ||
          lower.includes("missing anthropic_api_key")
        ) {
          setPhase("error");
          setRunning(false);
          refreshSecrets();
        }
      }),
      listen<string>("agent:done", async (event) => {
        const payload = String(event.payload);
        const msg = `\n[done] ${payload}`;
        setLogs((prev) => [...prev, msg]);

        if (payload === "paused") {
          setPhase("paused");
          setPausedAt(stopAfter);
        } else if (payload === "ok") {
          setPhase((prev) => (prev === "paused" ? prev : "done"));
        } else {
          setPhase("error");
        }

        setRunning(false);
        await refreshRunHistory();
        await refreshCurrentRun();
        await refreshAutofixState();
      }),
      listen<string>("phase:update", (event) => {
        const next = String(event.payload) as Phase;
        setPhase((prev) => (prev === "paused" ? prev : next));
      }),
    ];

    return () => {
      unlistenPromises.forEach(async (p) => {
        try {
          const unlisten = await p;
          unlisten();
        } catch {}
      });
    };
  }, [stopAfter, project]);

  useEffect(() => {
    if (mode === "full" && stopAfter !== "none") {
      setStopAfter("none");
    }
  }, [mode, stopAfter]);

  async function startRun(runMode: RunMode, runStopAfter: StopAfter) {
    if (running) return;

    setLogs([]);
    setRunning(true);
    setPhase("idle");

    const raw = prompt.replace(/\r\n/g, "\n");

    try {
      await invokeCommand("run_agent", {
        project,
        provider,
        mode: runMode,
        stopAfter: runStopAfter,
        prompt: raw,
      });
    } catch (e) {
      const msg = `[ui] invoke error: ${String(e)}`;
      setLogs((prev) => [...prev, msg]);
      setPhase("error");
      setRunning(false);
    }
  }

  async function onRun() {
    if (runLocked) {
      setLogs((prev) => [...prev, "[ui] run blocked: another run is still active or unrecovered"]);
      setPhase("error");
      await refreshCurrentRun();
      return;
    }

    if (!providerSecretPresent) {
      setLogs((prev) => [...prev, `[ui] missing required secret: ${requiredSecretName}`]);
      setPhase("error");
      await refreshSecrets();
      return;
    }

    if (!preflightComplete) {
      setLogs((prev) => [...prev, "[ui] preflight incomplete: run blocked"]);
      setPhase("error");
      await refreshPreflight();
      return;
    }

    setPausedAt("");
    await startRun(mode, stopAfter);
  }

  async function onEvaluateContinue() {
    try {
      setApprovalBusy(true);
      await invokeCommand("evaluate_continue", { project });
      setLogs((prev) => [...prev, "[ui] evaluate_continue completed"]);
      await refreshAutofixState();
    } catch (e) {
      setLogs((prev) => [...prev, `[ui] evaluate_continue failed: ${String(e)}`]);
    } finally {
      setApprovalBusy(false);
    }
  }

  async function onApproveContinue() {
    if (running || runLocked) return;
    try {
      setPausedAt("");
      await invokeCommand("continue_agent", {
        app: undefined,
        project,
        prompt,
        provider,
      });
      setLogs((prev) => [...prev, "[ui] continue_agent started"]);
      setRunning(true);
      await refreshCurrentRun();
    } catch (e) {
      setLogs((prev) => [...prev, `[ui] continue_agent blocked: ${String(e)}`]);
    }
  }

  const phaseItems: Array<{ key: Phase; label: string }> = [
    { key: "generate", label: "Generate" },
    { key: "analyze", label: "Analyze" },
    { key: "test", label: "Test" },
    { key: "reload", label: "Reload" },
    { key: "done", label: "Done" },
  ];

  function getPhaseStyle(item: Phase) {
    const order: Phase[] = ["idle", "generate", "analyze", "test", "reload", "done"];
    const currentIndex = order.indexOf(phase);
    const itemIndex = order.indexOf(item);
    const active = phase === item;
    const completed = currentIndex > itemIndex && phase !== "error" && phase !== "paused";

    return {
      border: active ? "1px solid #ffffff" : "1px solid #333",
      background: active ? "#ffffff" : completed ? "#1a1a1a" : "#111",
      color: active ? "#000" : completed ? "#9ee37d" : "#bbb",
    };
  }

  const statusText =
    phase === "idle"
      ? `Bereit · ${provider} · ${mode}`
      : phase === "paused"
      ? `Paused at: ${pausedAt || stopAfter}`
      : `Phase: ${phase}`;

  return (
    <div
      style={{
        height: "100vh",
        display: "grid",
        gridTemplateRows: "auto auto 1fr",
        gap: 12,
        padding: 16,
        background: "#0b0b0b",
        color: "#fff",
      }}
    >
      <div style={{ display: "grid", gap: 8 }}>
        <input
          value={project}
          onChange={(e) => setProject(e.target.value)}
          placeholder="Project name"
          style={{
            width: "100%",
            padding: 12,
            borderRadius: 12,
            border: "1px solid #333",
            background: "#111",
            color: "#fff",
            fontSize: 14,
          }}
        />

        <select
          value={provider}
          onChange={(e) => setProvider(e.target.value as Provider)}
          style={{
            width: "100%",
            padding: 12,
            borderRadius: 12,
            border: "1px solid #333",
            background: "#111",
            color: "#fff",
            fontSize: 14,
          }}
        >
          <option value="openai">openai</option>
          <option value="anthropic">anthropic</option>
        </select>

        <div
          style={{
            display: "grid",
            gap: 8,
            padding: 12,
            borderRadius: 12,
            border: "1px solid #333",
            background: "#111",
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 700 }}>
            Secret Status
          </div>

          <div style={{ fontSize: 12, color: providerSecretPresent ? "#9ee37d" : "#ffb86b" }}>
            {providerSecretPresent
              ? `${requiredSecretName} vorhanden`
              : `${requiredSecretName} fehlt`}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr auto auto", gap: 8 }}>
            <input
              type="password"
              value={secretInput}
              onChange={(e) => setSecretInput(e.target.value)}
              placeholder={`Paste ${requiredSecretName}`}
              style={{
                width: "100%",
                padding: 12,
                borderRadius: 10,
                border: "1px solid #333",
                background: "#0d0d0d",
                color: "#fff",
                fontSize: 13,
              }}
            />

            <button
              onClick={onSaveSecret}
              disabled={secretBusy || !secretInput.trim()}
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                border: "1px solid #333",
                background: secretBusy || !secretInput.trim() ? "#222" : "#fff",
                color: secretBusy || !secretInput.trim() ? "#888" : "#000",
                cursor: secretBusy || !secretInput.trim() ? "not-allowed" : "pointer",
                fontWeight: 600,
              }}
            >
              Save Key
            </button>

            <button
              onClick={refreshSecrets}
              disabled={secretBusy}
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                border: "1px solid #333",
                background: "#1a1a1a",
                color: "#fff",
                cursor: secretBusy ? "not-allowed" : "pointer",
                fontWeight: 600,
              }}
            >
              Refresh
            </button>
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gap: 8,
            padding: 12,
            borderRadius: 12,
            border: "1px solid #333",
            background: "#111",
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 700 }}>
            Preflight Status
          </div>

          <div style={{ fontSize: 12, color: preflightComplete ? "#9ee37d" : "#ffb86b" }}>
            {preflightComplete ? "Preflight vollständig" : "Preflight unvollständig"}
          </div>

          <div style={{ fontSize: 12, color: "#aaa" }}>
            schemaVersion: {preflightConfig?.schemaVersion ?? "unset"} · monetization:{" "}
            {preflightConfig?.monetization ?? "unset"} · completed:{" "}
            {preflightConfig?.completed ? "true" : "false"}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <select
              value={monetizationInput}
              onChange={(e) => setMonetizationInput(e.target.value as Monetization)}
              style={{
                width: "100%",
                padding: 12,
                borderRadius: 10,
                border: "1px solid #333",
                background: "#0d0d0d",
                color: "#fff",
                fontSize: 13,
              }}
            >
              <option value="unset">unset</option>
              <option value="free">free</option>
              <option value="paid">paid</option>
            </select>

            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "0 8px",
                borderRadius: 10,
                border: "1px solid #333",
                background: "#0d0d0d",
                color: "#fff",
                fontSize: 13,
              }}
            >
              <input
                type="checkbox"
                checked={completedInput}
                onChange={(e) => setCompletedInput(e.target.checked)}
              />
              completed
            </label>
          </div>

          <div
            style={{
              display: "grid",
              gap: 8,
              padding: 10,
              borderRadius: 10,
              border: "1px solid #333",
              background: "#0d0d0d",
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 700 }}>Supabase</div>

            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                color: "#fff",
                fontSize: 13,
              }}
            >
              <input
                type="checkbox"
                checked={supabaseEnabled}
                onChange={(e) => setSupabaseEnabled(e.target.checked)}
              />
              enabled
            </label>

            <input
              value={supabaseUrl}
              onChange={(e) => setSupabaseUrl(e.target.value)}
              placeholder="Supabase URL"
              style={{
                width: "100%",
                padding: 12,
                borderRadius: 10,
                border: "1px solid #333",
                background: "#111",
                color: "#fff",
                fontSize: 13,
              }}
            />

            <input
              value={supabaseAnonKey}
              onChange={(e) => setSupabaseAnonKey(e.target.value)}
              placeholder="Supabase anon key"
              style={{
                width: "100%",
                padding: 12,
                borderRadius: 10,
                border: "1px solid #333",
                background: "#111",
                color: "#fff",
                fontSize: 13,
              }}
            />
          </div>

          <div
            style={{
              display: "grid",
              gap: 8,
              padding: 10,
              borderRadius: 10,
              border: "1px solid #333",
              background: "#0d0d0d",
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 700 }}>SendGrid</div>

            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                color: "#fff",
                fontSize: 13,
              }}
            >
              <input
                type="checkbox"
                checked={sendgridEnabled}
                onChange={(e) => setSendgridEnabled(e.target.checked)}
              />
              enabled
            </label>

            <input
              value={sendgridApiKey}
              onChange={(e) => setSendgridApiKey(e.target.value)}
              placeholder="SendGrid API key"
              style={{
                width: "100%",
                padding: 12,
                borderRadius: 10,
                border: "1px solid #333",
                background: "#111",
                color: "#fff",
                fontSize: 13,
              }}
            />

            <input
              value={sendgridFromEmail}
              onChange={(e) => setSendgridFromEmail(e.target.value)}
              placeholder="SendGrid from email"
              style={{
                width: "100%",
                padding: 12,
                borderRadius: 10,
                border: "1px solid #333",
                background: "#111",
                color: "#fff",
                fontSize: 13,
              }}
            />
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              onClick={onSavePreflight}
              disabled={preflightSaveBusy}
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                border: "1px solid #333",
                background: preflightSaveBusy ? "#222" : "#fff",
                color: preflightSaveBusy ? "#888" : "#000",
                cursor: preflightSaveBusy ? "not-allowed" : "pointer",
                fontWeight: 600,
              }}
            >
              Save Preflight
            </button>

            <button
              onClick={refreshPreflight}
              disabled={preflightBusy}
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                border: "1px solid #333",
                background: preflightBusy ? "#222" : "#1a1a1a",
                color: preflightBusy ? "#888" : "#fff",
                cursor: preflightBusy ? "not-allowed" : "pointer",
                fontWeight: 600,
              }}
            >
              Refresh Preflight
            </button>
          </div>
        </div>

        {runLocked && (
          <div
            style={{
              display: "grid",
              gap: 6,
              padding: 12,
              borderRadius: 12,
              border: "1px solid #ff6b6b",
              background: "#1a1010",
              color: "#ffb3b3",
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 700 }}>
              Run Lock aktiv
            </div>
            <div style={{ fontSize: 12 }}>
              Es existiert noch ein aktiver oder nicht sauber wiederhergestellter Run.
              Bevor du neu startest, muss dieser Zustand erst bereinigt werden.
            </div>
          </div>
        )}

        <div
          style={{
            display: "grid",
            gap: 8,
            padding: 12,
            borderRadius: 12,
            border: "1px solid #333",
            background: "#111",
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 700 }}>
            Auto-Fix Summary
          </div>

          {autofixBusy ? (
            <div style={{ fontSize: 12, color: "#aaa" }}>Loading autofix summary...</div>
          ) : !autofixSelfHeal && !autofixRetryRun ? (
            <div style={{ fontSize: 12, color: "#aaa" }}>No autofix data yet</div>
          ) : (
            <div style={{ display: "grid", gap: 6 }}>
              <div style={{ fontSize: 12, color: "#fff" }}>
                self-heal: {autofixSelfHeal?.selfHealStatus ?? "-"}
              </div>
              <div style={{ fontSize: 12, color: "#fff" }}>
                retry: {autofixRetryRun?.retryRunStatus ?? "-"} · final: {autofixRetryRun?.finalRunStatus ?? "-"}
              </div>
              <div style={{ fontSize: 12, color: "#aaa" }}>
                failureStep: {autofixRetryRun?.failureStep ?? autofixSelfHeal?.failureStep ?? "-"}
              </div>
              <div style={{ fontSize: 12, color: "#aaa" }}>
                analyzeFailed: {autofixRetryRun?.analyzeFailed ? "true" : "false"} · testFailed: {autofixRetryRun?.testFailed ? "true" : "false"}
              </div>
              <div style={{ fontSize: 12, color: "#aaa" }}>
                removedFlags: {(autofixSelfHeal?.removedFlags ?? []).length > 0 ? (autofixSelfHeal?.removedFlags ?? []).join(", ") : "-"}
              </div>
              <div style={{ fontSize: 12, color: "#aaa" }}>
                notes: {autofixRetryRun?.notes ?? autofixSelfHeal?.reason ?? "-"}
              </div>
              <div style={{ fontSize: 12, color: "#fff" }}>
                safeMode: {autofixApproval?.safeMode ? "true" : "false"} · approval: {autofixApproval?.approvalStatus ?? "-"}
              </div>
              <div style={{ fontSize: 12, color: "#aaa" }}>
                requiresHumanApproval: {autofixApproval?.requiresHumanApproval ? "true" : "false"} · source: {autofixApproval?.sourceArtifact ?? "-"}
              </div>
              <div style={{ fontSize: 12, color: "#fff" }}>
                execution: {autofixExecution?.executionStatus ?? "-"}
              </div>
              <div style={{ fontSize: 12, color: "#aaa" }}>
                executionReason: {autofixExecution?.reason ?? "-"}
              </div>
              <div style={{ fontSize: 12, color: "#fff" }}>
                executionResult: {autofixExecutionResult?.executionResultStatus ?? "-"}
              </div>
              <div style={{ fontSize: 12, color: "#aaa" }}>
                touchedFiles: {(autofixExecutionResult?.touchedFiles ?? []).length > 0 ? (autofixExecutionResult?.touchedFiles ?? []).join(", ") : "-"}
              </div>
              <div style={{ fontSize: 12, color: "#aaa" }}>
                executionResultReason: {autofixExecutionResult?.reason ?? "-"}
              </div>
              <div style={{ fontSize: 12, color: "#fff" }}>
                rerun: {autofixRerun?.rerunStatus ?? "-"}
              </div>
              <div style={{ fontSize: 12, color: "#aaa" }}>
                rerunAnalyze: {autofixRerun?.analyzePassed ? "true" : "false"} ({autofixRerun?.analyzeExitCode ?? "-"})
                {" · "}
                rerunTest: {autofixRerun?.testPassed ? "true" : "false"} ({autofixRerun?.testExitCode ?? "-"})
              </div>
              <div style={{ fontSize: 12, color: "#aaa" }}>
                rerunReason: {autofixRerun?.reason ?? "-"}
              </div>
              <div style={{ fontSize: 12, color: effectiveVerifiedForContinue ? "#9ee37d" : "#ffb86b" }}>
                verifiedForContinue: {effectiveVerifiedForContinue ? "yes" : "no"}
              </div>
              <div style={{ fontSize: 12, color: "#fff" }}>
                continueGate: {autofixContinue?.continueStatus ?? "-"}
              </div>
              <div style={{ fontSize: 12, color: "#aaa" }}>
                continueReason: {autofixContinue?.reason ?? "-"}
              </div>

              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  onClick={() => onSetApprovalStatus("approved")}
                  disabled={approvalBusy || !autofixApproval}
                  style={{
                    padding: "8px 12px",
                    borderRadius: 10,
                    border: "1px solid #333",
                    background: approvalBusy || !autofixApproval ? "#222" : "#9ee37d",
                    color: approvalBusy || !autofixApproval ? "#888" : "#000",
                    cursor: approvalBusy || !autofixApproval ? "not-allowed" : "pointer",
                    fontWeight: 700,
                  }}
                >
                  Approve Patch
                </button>

                <button
                  onClick={() => onSetApprovalStatus("rejected")}
                  disabled={approvalBusy || !autofixApproval}
                  style={{
                    padding: "8px 12px",
                    borderRadius: 10,
                    border: "1px solid #333",
                    background: approvalBusy || !autofixApproval ? "#222" : "#3a1a1a",
                    color: approvalBusy || !autofixApproval ? "#888" : "#ffb3b3",
                    cursor: approvalBusy || !autofixApproval ? "not-allowed" : "pointer",
                    fontWeight: 700,
                  }}
                >
                  Reject Patch
                </button>

                <button
                  onClick={onEvaluateExecution}
                  disabled={approvalBusy || !autofixApproval}
                  style={{
                    padding: "8px 12px",
                    borderRadius: 10,
                    border: "1px solid #333",
                    background: approvalBusy || !autofixApproval ? "#222" : "#1a1a1a",
                    color: approvalBusy || !autofixApproval ? "#888" : "#fff",
                    cursor: approvalBusy || !autofixApproval ? "not-allowed" : "pointer",
                    fontWeight: 700,
                  }}
                >
                  Evaluate Execution
                </button>

                <button
                  onClick={onExecuteApprovedPatch}
                  disabled={approvalBusy || autofixExecution?.executionStatus !== "allowed"}
                  style={{
                    padding: "8px 12px",
                    borderRadius: 10,
                    border: "1px solid #333",
                    background: approvalBusy || autofixExecution?.executionStatus !== "allowed" ? "#222" : "#fff",
                    color: approvalBusy || autofixExecution?.executionStatus !== "allowed" ? "#888" : "#000",
                    cursor: approvalBusy || autofixExecution?.executionStatus !== "allowed" ? "not-allowed" : "pointer",
                    fontWeight: 700,
                  }}
                >
                  Execute Approved Patch
                </button>

                <button
                  onClick={onRerunAfterPatch}
                  disabled={approvalBusy || !["executed", "noop"].includes(autofixExecutionResult?.executionResultStatus ?? "")}
                  style={{
                    padding: "8px 12px",
                    borderRadius: 10,
                    border: "1px solid #333",
                    background: approvalBusy || !["executed", "noop"].includes(autofixExecutionResult?.executionResultStatus ?? "") ? "#222" : "#1a1a1a",
                    color: approvalBusy || !["executed", "noop"].includes(autofixExecutionResult?.executionResultStatus ?? "") ? "#888" : "#fff",
                    cursor: approvalBusy || !["executed", "noop"].includes(autofixExecutionResult?.executionResultStatus ?? "") ? "not-allowed" : "pointer",
                    fontWeight: 700,
                  }}
                >
                  Re-Run After Patch
                </button>
              </div>
            </div>
          )}

          <div
            style={{
              display: "grid",
              gap: 8,
              marginTop: 8,
              paddingTop: 8,
              borderTop: "1px solid #222",
            }}
          >
            <div style={{ fontSize: 12, fontWeight: 700, color: "#fff" }}>
              Artifact Inspector
            </div>

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[
                "autofix.json",
                "autofix.apply.json",
                "autofix.patch.json",
                "autofix.result.json",
                "autofix.retry.json",
                "autofix.retry.run.json",
                "autofix.selfheal.json",
                "autofix.approval.json",
                "autofix.execution.json",
                "autofix.execution.result.json",
                "autofix.rerun.json",
                "autofix.continue.json",
              ].map((name) => {
                const hasData = !!artifactMap[name];
                const selected = selectedArtifact === name;
                return (
                  <button
                    key={name}
                    onClick={() => setSelectedArtifact(name)}
                    style={{
                      padding: "8px 10px",
                      borderRadius: 10,
                      border: selected ? "1px solid #fff" : "1px solid #333",
                      background: selected ? "#fff" : hasData ? "#1a1a1a" : "#111",
                      color: selected ? "#000" : hasData ? "#fff" : "#666",
                      cursor: "pointer",
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    {name}
                  </button>
                );
              })}
            </div>

            <textarea
              readOnly
              value={artifactMap[selectedArtifact] || ""}
              placeholder="No artifact content"
              style={{
                width: "100%",
                minHeight: 220,
                padding: 12,
                borderRadius: 10,
                border: "1px solid #333",
                background: "#0d0d0d",
                color: "#ddd",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 12,
                lineHeight: 1.45,
                resize: "vertical",
              }}
            />
          </div>

          <button
            onClick={refreshAutofixState}
            disabled={autofixBusy}
            style={{
              width: "fit-content",
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid #333",
              background: autofixBusy ? "#222" : "#1a1a1a",
              color: autofixBusy ? "#888" : "#fff",
              cursor: autofixBusy ? "not-allowed" : "pointer",
              fontWeight: 600,
            }}
          >
            Refresh Auto-Fix
          </button>
        </div>

        <div
          style={{
            display: "grid",
            gap: 8,
            padding: 12,
            borderRadius: 12,
            border: runPossiblyActive ? "1px solid #ffb86b" : "1px solid #333",
            background: "#111",
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 700 }}>
            Current Run State
          </div>

          {currentRunBusy ? (
            <div style={{ fontSize: 12, color: "#aaa" }}>Loading current run...</div>
          ) : !currentRun ? (
            <div style={{ fontSize: 12, color: "#aaa" }}>No current run state</div>
          ) : (
            <>
              <div style={{ fontSize: 12, color: runPossiblyActive ? "#ffb86b" : "#9ee37d" }}>
                {runPossiblyActive
                  ? "Run läuft noch oder wurde nicht sauber beendet"
                  : "Letzter Run ist abgeschlossen"}
              </div>

              <div style={{ fontSize: 12, color: "#aaa" }}>
                status: {currentRun.status ?? "unknown"} · runId: {currentRun.runId ?? "-"}
              </div>

              <div style={{ fontSize: 12, color: "#aaa" }}>
                start: {formatTs(currentRun.startedAt)} · end: {formatTs(currentRun.finishedAt)}
              </div>
            </>
          )}


          <button
            onClick={refreshRunHistoryArtifacts}
            style={{
              padding: "8px 12px",
              borderRadius: 10,
              border: "1px solid #333",
              background: "#1a1a1a",
              color: "#fff",
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            Refresh Run Artifacts
          </button>

          <button
            onClick={refreshCurrentRun}
            disabled={currentRunBusy}
            style={{
              width: "fit-content",
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid #333",
              background: currentRunBusy ? "#222" : "#1a1a1a",
              color: currentRunBusy ? "#888" : "#fff",
              cursor: currentRunBusy ? "not-allowed" : "pointer",
              fontWeight: 600,
            }}
          >
            Refresh Current Run
          </button>
        </div>


        <div
          style={{
            display: "grid",
            gap: 8,
            padding: 12,
            borderRadius: 12,
            border: "1px solid #333",
            background: "#111",
            marginBottom: 12,
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 700 }}>
            Run-bound Artifact History
          </div>

          {!currentRun?.runId ? (
            <div style={{ fontSize: 12, color: "#aaa" }}>No current runId</div>
          ) : runHistoryArtifacts.length === 0 ? (
            <div style={{ fontSize: 12, color: "#aaa" }}>No history artifacts for current run</div>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              <div style={{ fontSize: 12, color: "#aaa" }}>
                runId: {currentRun.runId}
              </div>
              {groupedRunHistoryArtifacts.map((group) => (
                <div key={group.title} style={{ display: "grid", gap: 6 }}>
                  <div style={{ fontSize: 12, color: "#aaa", fontWeight: 700 }}>
                    {group.title}
                  </div>
                  {group.items.map((item) => {
                    const selected = selectedRunHistoryArtifact === item;
                    return (
                      <button
                        key={item}
                        onClick={() => openRunHistoryArtifact(item)}
                        style={{
                          padding: "8px 10px",
                          borderRadius: 10,
                          border: selected ? "1px solid #fff" : "1px solid #333",
                          background: selected ? "#fff" : "#0d0d0d",
                          color: selected ? "#000" : "#fff",
                          fontSize: 12,
                          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                          textAlign: "left",
                          cursor: "pointer",
                        }}
                      >
                        {item}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}

          <textarea
            readOnly
            value={runHistoryArtifactContent}
            placeholder="No run-bound artifact content selected"
            style={{
              width: "100%",
              minHeight: 180,
              padding: 12,
              borderRadius: 10,
              border: "1px solid #333",
              background: "#0d0d0d",
              color: "#ddd",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 12,
              lineHeight: 1.45,
              resize: "vertical",
            }}
          />
        </div>

        <div
          style={{
            display: "grid",
            gap: 8,
            padding: 12,
            borderRadius: 12,
            border: "1px solid #333",
            background: "#111",
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 700 }}>
            Recent Runs
          </div>

          {runHistoryBusy ? (
            <div style={{ fontSize: 12, color: "#aaa" }}>Loading run history...</div>
          ) : runHistory.length === 0 ? (
            <div style={{ fontSize: 12, color: "#aaa" }}>No runs yet</div>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              {runHistory.map((run, idx) => (
                <div
                  key={`${run.runId ?? "run"}-${idx}`}
                  style={{
                    display: "grid",
                    gap: 4,
                    padding: 10,
                    borderRadius: 10,
                    border: "1px solid #333",
                    background: "#0d0d0d",
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 700, color: "#fff" }}>
                    {run.status ?? "unknown"} · {run.runId ?? "-"}
                  </div>
                  <div style={{ fontSize: 12, color: "#aaa" }}>
                    start: {formatTs(run.startedAt)}
                  </div>
                  <div style={{ fontSize: 12, color: "#aaa" }}>
                    end: {formatTs(run.finishedAt)}
                  </div>
                </div>
              ))}
            </div>
          )}

          <button
            onClick={refreshRunHistory}
            disabled={runHistoryBusy}
            style={{
              width: "fit-content",
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid #333",
              background: runHistoryBusy ? "#222" : "#1a1a1a",
              color: runHistoryBusy ? "#888" : "#fff",
              cursor: runHistoryBusy ? "not-allowed" : "pointer",
              fontWeight: 600,
            }}
          >
            Refresh Run History
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as RunMode)}
            style={{
              width: "100%",
              padding: 12,
              borderRadius: 12,
              border: "1px solid #333",
              background: "#111",
              color: "#fff",
              fontSize: 14,
            }}
          >
            <option value="full">full</option>
            <option value="step">step</option>
          </select>

          <select
            value={stopAfter}
            onChange={(e) => setStopAfter(e.target.value as StopAfter)}
            disabled={mode === "full"}
            style={{
              width: "100%",
              padding: 12,
              borderRadius: 12,
              border: "1px solid #333",
              background: mode === "full" ? "#0d0d0d" : "#111",
              color: mode === "full" ? "#666" : "#fff",
              fontSize: 14,
            }}
          >
            <option value="none">none</option>
            <option value="registration">registration</option>
            <option value="onboarding">onboarding</option>
            <option value="core">core</option>
            <option value="design">design</option>
            <option value="finalize">finalize</option>
          </select>
        </div>

        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={`feature: todo_v1\ntitle: Todo Pro\nhome_title: Todo Home`}
          rows={6}
          style={{
            width: "100%",
            padding: 12,
            borderRadius: 12,
            border: "1px solid #333",
            background: "#111",
            color: "#fff",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            fontSize: 12,
            lineHeight: 1.4,
            resize: "vertical",
            whiteSpace: "pre-wrap",
          }}
        />

        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button
            onClick={onRun}
            disabled={running || runLocked || !providerSecretPresent || !preflightComplete}
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid #333",
              background: running || runLocked || !providerSecretPresent || !preflightComplete ? "#222" : "#fff",
              color: running || runLocked || !providerSecretPresent || !preflightComplete ? "#888" : "#000",
              cursor: running || runLocked || !providerSecretPresent || !preflightComplete ? "not-allowed" : "pointer",
              fontWeight: 600,
            }}
          >
            {running ? "Running…" : "Run"}
          </button>

          {(effectiveCurrentRunPhase === "paused" || currentRun?.status === "success") && (
            <>
              <button
                onClick={onEvaluateContinue}
                disabled={approvalBusy}
                style={{
                  padding: "10px 14px",
                  borderRadius: 10,
                  border: "1px solid #333",
                  background: approvalBusy ? "#222" : "#1a1a1a",
                  color: approvalBusy ? "#888" : "#fff",
                  cursor: approvalBusy ? "not-allowed" : "pointer",
                  fontWeight: 700,
                }}
              >
                Evaluate Continue
              </button>

              <button
                onClick={onApproveContinue}
                disabled={running || runLocked || !effectiveVerifiedForContinue}
                style={{
                  padding: "10px 14px",
                  borderRadius: 10,
                  border: "1px solid #333",
                  background: running || runLocked || !effectiveVerifiedForContinue ? "#3a4a33" : "#9ee37d",
                  color: running || runLocked || !effectiveVerifiedForContinue ? "#9aa58f" : "#000",
                  cursor: running || runLocked || !effectiveVerifiedForContinue ? "not-allowed" : "pointer",
                  fontWeight: 700,
                }}
              >
                Approve & Continue
              </button>
            </>
          )}

          <div style={{ color: "#aaa", fontSize: 13 }}>
            {statusText}
          </div>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
          gap: 8,
        }}
      >
        {phaseItems.map((item) => (
          <div
            key={item.key}
            style={{
              padding: "10px 12px",
              borderRadius: 10,
              textAlign: "center",
              fontSize: 12,
              fontWeight: 700,
              ...getPhaseStyle(item.key),
            }}
          >
            {item.label}
          </div>
        ))}
      </div>

      <textarea
        readOnly
        value={logText}
        style={{
          width: "100%",
          height: "100%",
          padding: 12,
          borderRadius: 12,
          border: phase === "error" ? "1px solid #ff6b6b" : "1px solid #333",
          background: "#111",
          color: "#ddd",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontSize: 12,
          lineHeight: 1.45,
          resize: "none",
        }}
      />
    </div>
  );
}
