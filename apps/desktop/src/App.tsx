import { useEffect, useMemo, useState } from "react";
import "./App.css";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

type AgentLogPayload = string;
type Phase = "idle" | "generate" | "analyze" | "test" | "reload" | "done" | "paused" | "error";
type Provider = "openai" | "anthropic";
type RunMode = "full" | "step";
type StopAfter = "none" | "registration" | "onboarding" | "core" | "design" | "finalize";

const SESSION_KEY = "flutter_builder_session_v1";

type SessionState = {
  project: string;
  provider: Provider;
  mode: RunMode;
  stopAfter: StopAfter;
  prompt: string;
};

type PreflightConfig = {
  completed?: boolean;
  monetization?: string;
  integrations?: Record<string, unknown>;
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
  const integrationsOk =
    !!cfg.integrations &&
    typeof cfg.integrations === "object" &&
    !Array.isArray(cfg.integrations);

  return completed && monetizationOk && integrationsOk;
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

  const logText = useMemo(() => logs.join("\n"), [logs]);

  const requiredSecretName =
    provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";

  const providerSecretPresent = secretNames.includes(requiredSecretName);
  const preflightComplete = isPreflightComplete(preflightConfig);

  async function refreshSecrets() {
    try {
      const names = await invoke<string[]>("list_secrets");
      setSecretNames(Array.isArray(names) ? names : []);
    } catch (e) {
      setLogs((prev) => [...prev, `[ui] list_secrets failed: ${String(e)}`]);
    }
  }

  async function refreshPreflight() {
    try {
      setPreflightBusy(true);
      const cfg = await invoke<PreflightConfig>("get_preflight_config", { project });
      setPreflightConfig(cfg ?? null);
    } catch (e) {
      setLogs((prev) => [...prev, `[ui] get_preflight_config failed: ${String(e)}`]);
      setPreflightConfig(null);
    } finally {
      setPreflightBusy(false);
    }
  }

  async function onSaveSecret() {
    const value = secretInput.trim();
    if (!value || secretBusy) return;

    try {
      setSecretBusy(true);
      await invoke("set_secret", {
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
      listen<string>("agent:done", (event) => {
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
  }, [stopAfter]);

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
      await invoke("run_agent", {
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

  async function onApproveContinue() {
    if (running) return;
    setPausedAt("");
    await startRun("full", "none");
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
            monetization: {preflightConfig?.monetization ?? "unset"} · completed:{" "}
            {preflightConfig?.completed ? "true" : "false"}
          </div>

          <button
            onClick={refreshPreflight}
            disabled={preflightBusy}
            style={{
              width: "fit-content",
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
            disabled={running || !providerSecretPresent || !preflightComplete}
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid #333",
              background: running || !providerSecretPresent || !preflightComplete ? "#222" : "#fff",
              color: running || !providerSecretPresent || !preflightComplete ? "#888" : "#000",
              cursor: running || !providerSecretPresent || !preflightComplete ? "not-allowed" : "pointer",
              fontWeight: 600,
            }}
          >
            {running ? "Running…" : "Run"}
          </button>

          {phase === "paused" && (
            <button
              onClick={onApproveContinue}
              disabled={running}
              style={{
                padding: "10px 14px",
                borderRadius: 10,
                border: "1px solid #333",
                background: "#9ee37d",
                color: "#000",
                cursor: running ? "not-allowed" : "pointer",
                fontWeight: 700,
              }}
            >
              Approve & Continue
            </button>
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
