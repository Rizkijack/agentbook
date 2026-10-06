import type { TownSnapshot, Contest, ContestKind, Season } from "@hermesbook/shared";
import { TownView } from "./TownView.js";
import { Link } from "../router/hash.js";
import { liveStandings } from "../canvas/WorldCanvas.js";
import { RANK_COLORS, ENTRANT_COLOR } from "../canvas/engine.js";
import { LOCATIONS } from "../canvas/locationsData.js";

/**
 * 08 §10.3 — `#/contest/:id` is the town canvas with the overlay forced on,
 * not a second renderer: the canvas below is `TownView` itself, untouched.
 * Everything else on this page is permalink context — the header and the
 * tables stay after the transient HUD bar has faded (08 §10.1).
 */

const KIND_LABEL: Record<ContestKind, string> = {
  gather_at: "gather at",
  hold_ground: "hold ground",
  tend_project: "tend project",
  endure: "endure",
};

const STATE_LABEL: Record<string, string> = { announced: "STARTING", live: "LIVE", resolved: "RESULT" };

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function RankChip({ rank }: { rank: number }) {
  return (
    <span
      data-testid="rank-chip"
      data-rank={rank}
      style={{
        display: "inline-block", minWidth: 16, textAlign: "center", padding: "1px 4px",
        fontFamily: "JetBrains Mono", fontSize: 10, color: "#1b1915",
        background: RANK_COLORS[rank - 1] ?? ENTRANT_COLOR,
      }}
    >
      {rank}
    </span>
  );
}

export function ContestView({ snapshot, id }: { snapshot: TownSnapshot; id?: string }) {
  const nameOf = (agentId: string) => snapshot.herd.find((h) => h.id === agentId)?.name ?? agentId.slice(0, 8);
  const contest: Contest | undefined = snapshot.contests?.find((c) => c.id === id);
  const season: Season | undefined = snapshot.season;

  if (!contest) {
    return (
      <div className="card">
        <div className="mono" style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--faint)" }}>
          Hermes Trials
        </div>
        <div style={{ fontFamily: "Instrument Serif", fontSize: 22, marginTop: 8 }}>
          {id ? "That contest is not in this save." : "No contest id in the route."}
        </div>
        <div className="mono muted" style={{ fontSize: 11, marginTop: 6 }}>
          {id ? <><code>{id}</code> may have been retired after resolution, or this world has not run it yet.</> : <>Open one from the town, e.g. <code>#/contest/ct-s1-d3-i0</code>.</>}
        </div>
        <div style={{ marginTop: 12 }}>
          <Link to="town" className="btn btn-ghost">← Back to town</Link>
        </div>
      </div>
    );
  }

  const venueName = LOCATIONS.find((l) => l.id === contest.place)?.name ?? contest.place;
  const standings = contest.state === "resolved" ? (contest.result?.standings ?? []) : [];
  const provisional = liveStandings(contest, snapshot.herd);

  return (
    <div className="stagger">
      {/* --- permalink header ------------------------------------------- */}
      <div className="card" style={{ padding: 18 }}>
        <div className="mono" style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--faint)" }}>
          Hermes Trials · Season {season?.no ?? 1} · {season?.state ?? "trials"}
        </div>

        <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginTop: 6, flexWrap: "wrap" }}>
          <div style={{ fontFamily: "Instrument Serif", fontSize: 30, lineHeight: 1, letterSpacing: "-0.02em" }}>{contest.title}</div>
          <span
            data-testid="contest-state"
            data-state={contest.state}
            className="mono"
            style={{
              fontSize: 10, letterSpacing: "0.1em", padding: "2px 7px", border: "1px solid #1b1915",
              color: contest.state === "live" ? ENTRANT_COLOR : "#1b1915",
            }}
          >
            {STATE_LABEL[contest.state] ?? contest.state}
          </span>
          <span className="mono" style={{ fontSize: 10, color: "var(--faint)" }}>{contest.id}</span>
        </div>

        <div style={{ fontFamily: "Instrument Serif", fontSize: 16, fontStyle: "italic", color: "var(--ink-2)", marginTop: 8, maxWidth: "72ch" }}>
          {contest.narration}
        </div>

        <div className="mono" style={{ fontSize: 11, color: "var(--muted)", marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <span>{KIND_LABEL[contest.kind]}</span>
          <span style={{ opacity: 0.4 }}>·</span>
          <span>venue {venueName}</span>
          <span style={{ opacity: 0.4 }}>·</span>
          <span>{clock(contest.startsAt)} → {clock(contest.endsAt)}</span>
          <span style={{ opacity: 0.4 }}>·</span>
          <span>{contest.entrants.length} entrants</span>
          {contest.houseEntrant && (
            <>
              <span style={{ opacity: 0.4 }}>·</span>
              <span>house agent {nameOf(contest.houseEntrant)}</span>
            </>
          )}
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
          {contest.entrants.map((agentId, i) => {
            const rank = standings.find((s) => s.agentId === agentId)?.rank;
            return (
              <span key={agentId} data-testid="contest-entrant" style={{ display: "inline-flex", alignItems: "center", gap: 6, border: `1px solid ${ENTRANT_COLOR}`, padding: "3px 8px", fontFamily: "JetBrains Mono", fontSize: 11 }}>
                {rank ? <RankChip rank={rank} /> : <span style={{ width: 6, height: 6, borderRadius: 999, background: ENTRANT_COLOR, display: "inline-block" }} />}
                {nameOf(agentId)}
              </span>
            );
          })}
        </div>
      </div>

      {/* --- the same #/town canvas, overlay forced on ------------------- */}
      <TownView snapshot={snapshot} />

      {/* --- result + season table --------------------------------------- */}
      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 16 }}>
        <div className="card">
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
            <div style={{ fontFamily: "Instrument Serif", fontSize: 14 }}>{contest.state === "resolved" ? "Result" : "Running order"}</div>
            <div className="mono" style={{ fontSize: 10, color: "var(--faint)" }}>
              {contest.state === "resolved" ? (contest.result?.voidResult ? "VOID · no points" : "rank points 10/5/1") : "ticks at venue"}
            </div>
          </div>
          <div style={{ marginTop: 10 }}>
            {contest.state === "resolved" && !contest.result && (
              <div className="mono muted" style={{ fontSize: 11 }}>Resolving — the evidence trail is still being read.</div>
            )}
            {contest.state === "resolved" && contest.result && (
              <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                {standings.map((s) => (
                  <li key={s.agentId} data-testid="standing-row" style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: "JetBrains Mono", fontSize: 12 }}>
                    <RankChip rank={s.rank} />
                    <span style={{ fontWeight: s.rank === 1 ? 700 : 400 }}>{nameOf(s.agentId)}</span>
                    <span className="muted" style={{ fontSize: 11, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{s.detail}</span>
                    <span style={{ fontWeight: 700 }}>+{contest.result?.voidResult ? 0 : s.score}</span>
                  </li>
                ))}
              </ol>
            )}
            {contest.state !== "resolved" && (
              <ol style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
                {provisional.map((row, i) => (
                  <li key={row.agentId} data-testid="standing-row" style={{ display: "flex", alignItems: "center", gap: 10, fontFamily: "JetBrains Mono", fontSize: 12 }}>
                    <span style={{ color: RANK_COLORS[i] ?? ENTRANT_COLOR, width: 14 }}>{i + 1}.</span>
                    <span>{row.name}</span>
                    <span style={{ flex: 1, borderBottom: "1px dotted var(--hair)" }} />
                    <span style={{ fontWeight: 700 }}>{row.metric}</span>
                  </li>
                ))}
                {provisional.length === 0 && <li className="mono muted" style={{ fontSize: 11 }}>No entrants yet.</li>}
              </ol>
            )}
          </div>
        </div>

        <div className="card">
          <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
            <div style={{ fontFamily: "Instrument Serif", fontSize: 14 }}>Season {season?.no ?? 1} table</div>
            <div className="mono" style={{ fontSize: 10, color: "var(--faint)" }}>{season?.state ?? "—"}</div>
          </div>
          {!season && <div className="mono muted" style={{ fontSize: 11, marginTop: 10 }}>No season standings in this save.</div>}
          {season && (
            <div style={{ marginTop: 10, display: "flex", flexDirection: "column" }}>
              {season.standings.slice(0, 8).map((s, i) => (
                <div key={s.agentId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderTop: i === 0 ? "1px solid var(--hair)" : "1px solid color-mix(in srgb, var(--hair) 60%, transparent)", fontFamily: "JetBrains Mono", fontSize: 12 }}>
                  <span style={{ color: RANK_COLORS[i] ?? "var(--muted)", width: 14 }}>{i + 1}.</span>
                  <span style={{ flex: 1 }}>{nameOf(s.agentId)}</span>
                  <span className="muted" style={{ fontSize: 11 }}>{s.wins}W-{s.losses}L</span>
                  <span style={{ fontWeight: 700 }}>{s.points}</span>
                </div>
              ))}
              {season.standings.length === 0 && <div className="mono muted" style={{ fontSize: 11 }}>Table is still empty.</div>}
              {season.champion && (
                <div className="mono" style={{ fontSize: 11, marginTop: 10, borderTop: "1px solid var(--hair)", paddingTop: 8 }}>
                  Champion: <strong>{nameOf(season.champion)}</strong>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="mono" style={{ fontSize: 11 }}>
        <Link to="town">← Back to the town</Link>
        <span style={{ marginLeft: 12, color: "var(--faint)" }}>This link is the contest permalink.</span>
      </div>

      <style>{`@media (max-width: 900px){ div[style*="grid-template-columns: 1.4fr"]{ grid-template-columns: 1fr !important; } }`}</style>
    </div>
  );
}
