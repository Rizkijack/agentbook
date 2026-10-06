import type { TownSnapshot, Quest } from "@hermesbook/shared";
import { useState } from "react";

function diffLabel(expiresAt: number | null): string {
  if (!expiresAt) return "no expiry";
  const ms = expiresAt - Date.now();
  if (ms <= 0) return "expired";
  const h = Math.floor(ms / 3600000);
  if (h < 1) return `${Math.floor(ms / 60000)}m left`;
  if (h < 24) return `${h}h left`;
  return `${Math.floor(h / 24)}d left`;
}

function QuestCard({ q, onClaim, claiming }: { q: Quest; onClaim: (id: string) => void; claiming?: boolean }) {
  const pct = Math.min(100, Math.round((q.progress / q.required) * 100));
  const isActive = q.status === "active" || q.status === "available";
  const isCompleted = q.status === "completed";
  const isClaimed = q.status === "claimed";

  return (
    <div
      className="card"
      style={{
        padding: 0,
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
        opacity: isClaimed ? 0.72 : 1,
        borderColor: isCompleted ? "var(--accent)" : "var(--hair)",
        borderWidth: isCompleted ? 1.5 : 1,
      }}
    >
      <div style={{ padding: 14, flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span
            className="mono"
            style={{
              fontSize: 10,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              background: q.difficulty === "hard" ? "var(--ink)" : q.difficulty === "medium" ? "var(--mark)" : "transparent",
              color: q.difficulty === "hard" ? "var(--paper)" : "var(--muted)",
              border: `1px solid ${q.difficulty === "hard" ? "var(--ink)" : "var(--hair)"}`,
              padding: "2px 6px",
              borderRadius: 20,
            }}
          >
            {q.difficulty} · {q.category}
          </span>
          <span className="mono" style={{ fontSize: 10, color: "var(--faint)" }}>{diffLabel(q.expiresAt)}</span>
          {isCompleted && <span className="mono" style={{ fontSize: 10, background: "var(--accent)", color: "var(--paper)", padding: "2px 6px", borderRadius: 20 }}>ready to claim</span>}
          {isClaimed && <span className="mono" style={{ fontSize: 10, background: "var(--hair)", color: "var(--muted)", padding: "2px 6px", borderRadius: 20 }}>done</span>}
        </div>

        <div style={{ fontFamily: "Instrument Serif", fontSize: 18, lineHeight: 1, marginTop: 10, letterSpacing: "-0.01em" }}>{q.title}</div>
        <div className="mono" style={{ fontSize: 11, lineHeight: 1.5, color: "var(--ink-2)", marginTop: 6 }}>{q.description}</div>

        <div className="mono" style={{ fontSize: 10, color: "var(--faint)", marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
          <span>from {q.giverName}</span>
          <span style={{ opacity: 0.4 }}>·</span>
          <span>{q.type}</span>
          {q.targetPlace && <span style={{ opacity: 0.7 }}>→ {q.targetPlace}</span>}
          {q.targetPlaces && <span style={{ opacity: 0.7 }}>→ {q.targetPlaces.join(", ")}</span>}
        </div>

        <div style={{ marginTop: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <span className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>progress</span>
            <span className="mono" style={{ fontSize: 10, color: isCompleted ? "var(--ink)" : "var(--muted)" }}>
              {q.progress}/{q.required} · {pct}%
            </span>
          </div>
          <div style={{ marginTop: 6, height: 6, background: "color-mix(in srgb, var(--hair) 70%, transparent)", borderRadius: 6, overflow: "hidden" }}>
            <div
              style={{
                width: `${pct}%`,
                height: "100%",
                background: isCompleted ? "var(--accent)" : isActive ? "var(--ink)" : "var(--muted)",
                transition: "width 0.4s ease",
              }}
            />
          </div>
        </div>

        <div
          className="mono"
          style={{
            marginTop: 10,
            fontSize: 10,
            background: "color-mix(in srgb, var(--mark) 55%, var(--paper-2) 45%)",
            border: "1px solid color-mix(in srgb, var(--hair) 60%, transparent)",
            padding: "6px 8px",
            borderRadius: 6,
            color: "var(--ink-2)",
          }}
        >
          reward: {q.reward.text}
        </div>
      </div>

      <div style={{ padding: "10px 14px", borderTop: "1px solid var(--hair)", background: "color-mix(in srgb, var(--paper) 60%, var(--paper-2) 40%)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span className="mono" style={{ fontSize: 10, color: "var(--faint)" }}>{q.status} · {new Date(q.createdAt).toLocaleDateString()}</span>
        {isCompleted && (
          <button className="btn" style={{ padding: "6px 12px", fontSize: 11 }} onClick={() => onClaim(q.id)} disabled={!!claiming}>
            {claiming ? "claiming..." : "Claim Reward"}
          </button>
        )}
        {isActive && <span className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>auto-filled by herd activity</span>}
        {isClaimed && <span className="mono" style={{ fontSize: 10, color: "var(--faint)" }}>✓ reward applied</span>}
      </div>
    </div>
  );
}

export function QuestView({ snapshot }: { snapshot: TownSnapshot }) {
  const [claiming, setClaiming] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const quests = (snapshot as any).quests as Quest[] | undefined ?? [];
  const active = quests.filter((q) => q.status === "active" || q.status === "available");
  const completed = quests.filter((q) => q.status === "completed");
  const claimed = quests.filter((q) => q.status === "claimed");

  async function claim(id: string) {
    setClaiming(id);
    setMsg(null);
    try {
      const res = await fetch(`/api/quests/${id}/claim`, { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "claim failed");
      setMsg(`Claimed: ${data.title}`);
      // snapshot will refresh via SSE quest event; also force reload after 800ms
      setTimeout(() => window.location.reload(), 900);
    } catch (e: any) {
      setMsg(e.message ?? "failed");
    } finally {
      setClaiming(null);
    }
  }

  async function refresh() {
    await fetch("/api/quests/refresh", { method: "POST" });
    window.location.reload();
  }

  return (
    <div className="stagger">
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <div>
          <div className="mono" style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--faint)" }}>Quest Board · Notice Board</div>
          <div style={{ fontFamily: "Instrument Serif", fontSize: 32, lineHeight: 1, letterSpacing: "-0.02em", marginTop: 6 }}>Town Daily Quests</div>
          <div className="mono" style={{ fontSize: 11, color: "var(--muted)", marginTop: 6, maxWidth: "60ch" }}>
            Quests run on their own — every move, chat, and chore from the herd fills the progress bar. No accept button, just live in town. Claim when it's ready.
          </div>
        </div>
        <button className="btn btn-ghost" style={{ fontSize: 11, padding: "8px 12px" }} onClick={refresh}>
          Refresh Board
        </button>
      </div>

      {msg && <div className="mono" style={{ marginTop: 12, background: "var(--mark)", border: "1px solid var(--hair)", padding: "8px 10px", borderRadius: 6, fontSize: 12 }}>{msg}</div>}

      {/* bento: active hero + completed */}
      {active.length === 0 && completed.length === 0 && claimed.length === 0 && (
        <div className="card" style={{ marginTop: 16, textAlign: "center", padding: 24 }}>
          <div className="mono" style={{ fontSize: 12, color: "var(--muted)" }}>No quests yet. Wait for the daily rotation or hit Refresh.</div>
        </div>
      )}

      {active.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div className="mono" style={{ fontSize: 11, color: "var(--muted)", marginBottom: 8 }}>Active · {active.length} quests running on their own</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
            {active.map((q) => (
              <QuestCard key={q.id} q={q} onClaim={claim} claiming={claiming === q.id} />
            ))}
          </div>
        </div>
      )}

      {completed.length > 0 && (
        <div style={{ marginTop: 22 }}>
          <div style={{ fontFamily: "Instrument Serif", fontSize: 18, color: "var(--ink)" }}>Ready to Claim · {completed.length}</div>
          <div className="mono" style={{ fontSize: 11, color: "var(--muted)", marginBottom: 8 }}>Finish them, then claim for spirits & project progress.</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
            {completed.map((q) => (
              <QuestCard key={q.id} q={q} onClaim={claim} claiming={claiming === q.id} />
            ))}
          </div>
        </div>
      )}

      {claimed.length > 0 && (
        <div style={{ marginTop: 22 }}>
          <div className="mono" style={{ fontSize: 11, color: "var(--faint)", marginBottom: 8 }}>Done · {claimed.length} claimed</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 12, opacity: 0.9 }}>
            {claimed.slice(0, 6).map((q) => (
              <QuestCard key={q.id} q={q} onClaim={claim} claiming={claiming === q.id} />
            ))}
          </div>
        </div>
      )}

      <div className="card" style={{ marginTop: 18, background: "color-mix(in srgb, var(--mark) 45%, var(--paper-2) 55%)" }}>
        <div className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>How it works</div>
        <div className="mono" style={{ fontSize: 11, lineHeight: 1.6, color: "var(--ink-2)", marginTop: 6 }}>
          • <strong>visit</strong> = visit the target location • <strong>talk</strong> = talk/argue at a location • <strong>explore</strong> = visit all targetPlaces (distinct) • <strong>fetch</strong> = graze in a field • <strong>work</strong> = work a job • <strong>social</strong> = post/reply in the feed. The bots move on their own and fill every one — you just claim.
        </div>
      </div>
    </div>
  );
}
