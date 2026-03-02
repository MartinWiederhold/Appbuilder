import { useEffect, useMemo, useState } from "react";
import { readRunJson, type RunJson } from "../lib/runJson";

const RUN_JSON_ABS = "/Users/martinwiederhold/dev/flutter-builder/workspace/projects/todo_flutter/run.json";

function fmt(iso?: string) {
  if (!iso) return "-";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function StatusPill({ status }: { status?: string }) {
  const label = status ?? "unknown";
  const style: React.CSSProperties =
    label === "success"
      ? { background: "#0a7", color: "white" }
      : label === "failed"
      ? { background: "#d33", color: "white" }
      : { background: "#777", color: "white" };

  return (
    <>
      <div style={{ color: "#aaa", fontSize: 12, marginBottom: 8 }}>BMAD Phase: {bmadPhase ?? "—"}</div>

    <span style={{ ...style, padding: "4px 8px", borderRadius: 999, fontSize: 12 }}>
      {label}
    </span>
    </>
  );
}

export default function RunStatusCard({ bmadPhase }: { bmadPhase?: string }) {
  const [data, setData] = useState<RunJson | null>(null);
  const [lastReadAt, setLastReadAt] = useState<number>(0);

  async function refresh() {
    const j = await readRunJson(RUN_JSON_ABS);
    setData(j);
    setLastReadAt(Date.now());
  }

  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 1000);
    return () => window.clearInterval(id);
  }, []);

  const steps = data?.steps ?? [];
  const lastStep = useMemo(() => {
  if (!steps.length) return null;
  const s = steps[steps.length - 1];
  return `${s?.name ?? "step"} (exit=${s?.exitCode ?? "?"})`;
}, [steps]);

  return (
    <div style={{
      border: "1px solid #333",
      borderRadius: 12,
      padding: 16,
      marginBottom: 16,
      background: "#111",
      color: "#eee",
      display: "grid",
      gap: 8
    }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <strong>Run Status</strong>
        <div style={{ display: "flex", gap: 10 }}>
          <StatusPill status={data?.status} />
          <button onClick={refresh}>Refresh</button>
        </div>
      </div>

      <div style={{ fontSize: 13, display: "grid", gridTemplateColumns: "140px 1fr", gap: 6 }}>
        <div>Project</div><div>{data?.project ?? "-"}</div>
        <div>Exit code</div><div>{String(data?.exitCode ?? "-")}</div>
        <div>Started</div><div>{fmt(data?.startedAt)}</div>
        <div>Finished</div><div>{fmt(data?.finishedAt)}</div>
        <div>Last step
BMAD Phase</div><div>{lastStep ?? "-"}</div>
        <div>Last read</div><div>{new Date(lastReadAt).toLocaleTimeString()}</div>
      </div>

      {data === null && (
        <div style={{ color: "#f55" }}>
          Could not read run.json (check Tauri fs scope).
        </div>
      )}
    </div>
  );
}
