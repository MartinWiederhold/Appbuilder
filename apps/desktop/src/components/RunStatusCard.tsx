import React from "react";

type Props = {
  status?: string;
  exitCode?: number | null;
  lastStep?: string | null;
  bmadPhase?: string | null;
};

export default function RunStatusCard(props: Props) {
  const { status, exitCode, lastStep, bmadPhase } = props;

  const label =
    status === "running"
      ? "running"
      : status === "success"
        ? "success"
        : status === "error"
          ? "error"
          : status ?? "idle";

  const pillStyle: React.CSSProperties = {
    display: "inline-block",
    padding: "6px 10px",
    borderRadius: 999,
    fontSize: 12,
    border: "1px solid #333",
    color: "#ddd",
    background: "#111",
  };

  return (
    <div
      style={{
        border: "1px solid #333",
        borderRadius: 16,
        padding: 20,
        minHeight: 180,
        background: "rgba(0,0,0,0.25)",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ fontSize: 28, fontWeight: 700 }}>Run Status</div>
        <span style={pillStyle}>{label}</span>
      </div>

      <div style={{ marginTop: 14, color: "#aaa", fontSize: 13 }}>
        BMAD Phase: <span style={{ color: "#ddd" }}>{bmadPhase ?? "—"}</span>
      </div>

      <div style={{ marginTop: 18, color: "#bbb", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
        {exitCode !== undefined && exitCode !== null && (
          <div style={{ marginBottom: 6 }}>exitCode: {exitCode}</div>
        )}
        {lastStep && <div style={{ marginBottom: 6 }}>lastStep: {lastStep}</div>}
      </div>
    </div>
  );
}
