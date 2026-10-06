import { useState } from "react";
import type { TownSnapshot } from "@hermesbook/shared";

type Tab = "latest" | "replies" | "spit" | "what happened";

export function FeedView({ snapshot }: { snapshot: TownSnapshot }) {
  const [tab, setTab] = useState<Tab>("latest");

  const items = (() => {
    switch (tab) {
      case "latest": return snapshot.feed;
      case "replies": return snapshot.feed.filter((p) => p.kind === "reply" || p.replyTo);
      case "spit": return snapshot.feed.filter((p) => p.kind === "spit");
      case "what happened": return snapshot.events.map((e) => ({ id: String(e.t), t: e.t, by: "", name: e.kind, handle: "", text: e.text, kind: "post" as const, replyTo: null }));
      default: return snapshot.feed;
    }
  })();

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        {(["latest", "replies", "spit", "what happened"] as const).map((t) => (
          <button key={t} className={tab === t ? "btn" : "btn btn-ghost"} style={{ padding: "6px 10px", fontSize: 11 }} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>
      <div className="stagger" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {items.slice(0, 80).map((p) => {
          const author = snapshot.herd.find((h) => h.id === p.by);
          return (
            <div key={p.id} className="card" style={{ display: "flex", gap: 12 }}>
              <div style={{ width: 36, height: 36, borderRadius: "50%", background: "#e8e3d7", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, flexShrink: 0 }}>
                {(p.name[0] ?? "?").toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 700 }}>{p.name || author?.name || "unknown"}</span>
                  <span className="mono muted" style={{ fontSize: 11 }}>{p.handle || author?.handle || ""}</span>
                  <span className="mono faint" style={{ fontSize: 10 }}>{new Date(p.t).toLocaleString()}</span>
                  {p.kind === "spit" && <span className="mono" style={{ fontSize: 10, background: "#cfe8f2", padding: "1px 5px", borderRadius: 4 }}>spit</span>}
                </div>
                <div style={{ marginTop: 6, fontSize: 14, lineHeight: 1.45 }}>{p.text}</div>
              </div>
            </div>
          );
        })}
        {items.length === 0 && <div className="card mono muted" style={{ padding: 24, textAlign: "center" }}>No entries in {tab}</div>}
      </div>
    </div>
  );
}
