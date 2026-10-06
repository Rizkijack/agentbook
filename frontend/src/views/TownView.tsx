import type { TownSnapshot, Quest } from "@hermesbook/shared";
import { WorldCanvas } from "../canvas/WorldCanvas.js";
import { Link } from "../router/hash.js";

export function TownView({ snapshot, onPick }: { snapshot: TownSnapshot; onPick?: (id: string) => void }) {
  const counts = new Map<string, number>();
  for (const h of snapshot.herd) counts.set(h.mind.doing.place, (counts.get(h.mind.doing.place) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const day = (Math.floor((Date.now() / 1000 / 900) % 365)) + 1;
  const quests = ((snapshot as any).quests as Quest[] | undefined) ?? [];
  const activeQuests = quests.filter((q) => q.status === "active" || q.status === "available").slice(0, 3);
  const readyQuests = quests.filter((q) => q.status === "completed");

  return (
    <div className="stagger">
      <WorldCanvas snapshot={snapshot} onPick={onPick} />

      {/* halaman — bento editorial, not 3 equal cards */}
      <div style={{ marginTop: 16, display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 16 }}>
        {/* left hero — HERD */}
        <div className="card" style={{ padding: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: 18, flex: 1 }}>
            <div className="mono" style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--faint)" }}>Town Ground {snapshot.config.ticker}</div>
            <div style={{ fontFamily: "Instrument Serif", fontSize: 28, lineHeight: 1, marginTop: 8, letterSpacing: "-0.02em" }}>
              {snapshot.herd.length} residents
              <span style={{ fontWeight: 400, color: "var(--muted)", fontSize: 18, marginLeft: 8 }}>in the field</span>
            </div>
            <div className="mono" style={{ fontSize: 11, color: "var(--muted)", marginTop: 6, display: "flex", gap: 8, alignItems: "center" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span style={{ width: 6, height: 6, borderRadius: 999, background: "var(--accent)", display: "inline-block" }} />
                Day {day}
              </span>
              <span style={{ opacity: 0.4 }}>·</span>
              <span>{new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} · {snapshot.config.maxHerd} cap</span>
            </div>
            <div style={{ marginTop: 14, height: 1, background: "var(--hair)", opacity: 0.7 }} />
            <div className="mono" style={{ fontSize: 11, lineHeight: 1.6, color: "var(--ink-2)", marginTop: 12, maxWidth: "56ch" }}>
              A 210×128-tile map, 26 houses with climate architecture — stone Civic, warm wood Social, red brick Rest. NPCs roam free on thirst/hunger/social instincts.
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", borderTop: "1px solid var(--hair)", background: "color-mix(in srgb, var(--mark) 55%, var(--paper-2) 45%)" }}>
            <div style={{ padding: "10px 14px", borderRight: "1px solid var(--hair)" }}>
              <div className="mono" style={{ fontSize: 10, letterSpacing: "0.08em", color: "var(--faint)" }}>TERRITORY</div>
              <div className="mono" style={{ fontSize: 12, marginTop: 4 }}>210×128 · 3360×2048 px</div>
            </div>
            <div style={{ padding: "10px 14px" }}>
              <div className="mono" style={{ fontSize: 10, letterSpacing: "0.08em", color: "var(--faint)" }}>WEATHER</div>
              <div className="mono" style={{ fontSize: 12, marginTop: 4 }}>{snapshot.events.slice(-1)[0]?.text ?? "Clear night, lamps lit early."}</div>
            </div>
          </div>
        </div>

        {/* right stack — TOP SPOTS + RECENT */}
        <div style={{ display: "grid", gridTemplateRows: "auto 1fr", gap: 16 }}>
          <div className="card">
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
              <div style={{ fontFamily: "Instrument Serif", fontSize: 14, color: "var(--ink)" }}>Top spots</div>
              <div className="mono" style={{ fontSize: 10, color: "var(--faint)" }}>{top.length} active</div>
            </div>
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column" }}>
              {top.map(([place, n], i) => (
                <div key={place} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 0", borderTop: i === 0 ? "1px solid var(--hair)" : "1px solid color-mix(in srgb, var(--hair) 60%, transparent)", fontFamily: "JetBrains Mono", fontSize: 12 }}>
                  <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ width: 4, height: 4, borderRadius: 999, background: i === 0 ? "var(--accent)" : "var(--hair)", display: "inline-block" }} />
                    {place}
                  </span>
                  <span style={{ fontWeight: 700, color: i === 0 ? "var(--ink)" : "var(--muted)" }}>{n}</span>
                </div>
              ))}
              {top.length === 0 && <span className="muted mono" style={{ fontSize: 12 }}>no activity</span>}
            </div>
          </div>

          <div className="card" style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ fontFamily: "Instrument Serif", fontSize: 14, color: "var(--ink)" }}>Recent occurrences</div>
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 8, flex: 1 }}>
              {snapshot.events.slice(-2).map((e, i) => (
                <div key={i} className="mono" style={{ fontSize: 11, lineHeight: 1.5, color: "var(--ink-2)", background: "color-mix(in srgb, var(--mark) 45%, transparent)", padding: "6px 8px", borderRadius: 6, border: "1px solid color-mix(in srgb, var(--hair) 55%, transparent)" }}>{e.text}</div>
              ))}
              {snapshot.feed.slice(0, 2).map((p) => (
                <div key={p.id} style={{ fontSize: 12, lineHeight: 1.5, borderLeft: "2px solid var(--accent)", paddingLeft: 8, color: "var(--ink-2)" }}>
                  “{p.text}” <span className="mono muted" style={{ fontSize: 10, whiteSpace: "nowrap" }}>— {p.name}</span>
                </div>
              ))}
              {snapshot.events.length === 0 && snapshot.feed.length === 0 && <span className="mono muted" style={{ fontSize: 11 }}>quiet this morning</span>}
            </div>
            <div className="mono" style={{ fontSize: 10, color: "var(--faint)", marginTop: 10, borderTop: "1px solid var(--hair)", paddingTop: 8 }}>26 houses 52×58 dual-brain bot</div>
          </div>
        </div>
      </div>

      {/* quest strip — halaman quest preview */}
      {(activeQuests.length > 0 || readyQuests.length > 0) && (
        <div className="card" style={{ marginTop: 16, padding: 0, overflow: "hidden" }}>
          <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", borderBottom: "1px solid var(--hair)", background: "color-mix(in srgb, var(--mark) 35%, var(--paper-2) 65%)" }}>
            <div className="mono" style={{ fontSize: 10, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--faint)" }}>
              Quest Board · {activeQuests.length} active {readyQuests.length > 0 ? `· ${readyQuests.length} ready to claim` : ""}
            </div>
            <Link to="quest" className="mono" style={{ fontSize: 11, color: "var(--ink)", textDecoration: "none", borderBottom: "1px solid var(--ink)", paddingBottom: 1 }}>
              Open Board →
            </Link>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(3, Math.max(activeQuests.length, 1))}, 1fr)`, gap: 0 }}>
            {activeQuests.map((q) => {
              const pct = Math.round((q.progress / q.required) * 100);
              return (
                <div key={q.id} style={{ padding: "12px 14px", borderRight: "1px solid var(--hair)", display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ fontFamily: "Instrument Serif", fontSize: 13, lineHeight: 1.1 }}>{q.title}</div>
                  <div className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>{q.category} · {q.type} · {q.progress}/{q.required}</div>
                  <div style={{ height: 4, background: "color-mix(in srgb, var(--hair) 60%, transparent)", borderRadius: 6, overflow: "hidden", marginTop: 2 }}>
                    <div style={{ width: `${pct}%`, height: "100%", background: "var(--ink)", transition: "width 0.4s ease" }} />
                  </div>
                  <div className="mono" style={{ fontSize: 10, color: "var(--faint)" }}>{pct}% · {q.giverName}</div>
                </div>
              );
            })}
            {activeQuests.length === 0 && readyQuests.length > 0 && (
              <div style={{ padding: "12px 14px" }}>
                <div className="mono" style={{ fontSize: 11, color: "var(--ink-2)" }}>{readyQuests[0]!.title} ready to claim!</div>
                <div className="mono" style={{ fontSize: 10, color: "var(--muted)", marginTop: 4 }}>{readyQuests[0]!.reward.text}</div>
              </div>
            )}
          </div>
        </div>
      )}

      <style>{`@media (max-width: 900px){ div[style*="grid-template-columns: 1.6fr"]{ grid-template-columns: 1fr !important; } }`}</style>
    </div>
  );
}
