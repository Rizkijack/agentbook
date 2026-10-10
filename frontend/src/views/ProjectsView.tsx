import type { TownSnapshot } from "@slopagentbook/shared";
import { Link } from "../router/hash.js";

/**
 * Projects and factions — the two things the town is doing together that nothing
 * else renders. Both are seeded in world.ts, progress through quests.ts and the
 * turn loop, and ride along in /api/snapshot; they just had no route.
 *
 * Read-only. Sponsors and members resolve against the live herd, so a resident
 * who has left shows as its id rather than a name.
 */
export function ProjectsView({ snapshot }: { snapshot: TownSnapshot }) {
  const nameOf = (id: string) => snapshot.herd.find((h) => h.id === id)?.name ?? id.slice(0, 6);

  return (
    <div className="stagger">
      <div className="mono muted" style={{ fontSize: 11, marginBottom: 12 }}>
        what the town is building, and who is building it
      </div>

      <div className="grid grid-2">
        {snapshot.projects.map((p) => (
          <div key={p.id} className="card" data-testid="project-card">
            <div style={{ fontWeight: 700, fontSize: 16 }}>{p.name}</div>
            <div className="mono muted" style={{ fontSize: 12, marginTop: 4 }}>{p.purpose}</div>

            <div
              role="progressbar"
              aria-valuenow={Math.round(p.progress * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${p.name} progress`}
              style={{ height: 8, marginTop: 12, border: "1px solid var(--hair)", borderRadius: 4, overflow: "hidden", background: "var(--paper-2)" }}
            >
              <div style={{ width: `${Math.round(p.progress * 100)}%`, height: "100%", background: "var(--ink)" }} />
            </div>
            <div className="mono" data-testid="project-progress" style={{ fontSize: 11, marginTop: 6, color: "var(--muted)" }}>
              {Math.round(p.progress * 100)}% done
            </div>

            {p.sponsors.length > 0 && (
              <>
                <div className="mono" style={{ fontSize: 10, marginTop: 12, letterSpacing: "0.08em", color: "var(--faint)" }}>
                  SPONSORS
                </div>
                <div style={{ marginTop: 4, display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {p.sponsors.map((id) => (
                    <Link key={id} to={`llama/${id}`} className="mono" style={{ fontSize: 11, textDecoration: "none", color: "var(--ink)", border: "1px solid var(--hair)", padding: "2px 6px", borderRadius: 4 }}>
                      {nameOf(id)}
                    </Link>
                  ))}
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      <div className="mono muted" style={{ fontSize: 11, margin: "24px 0 12px" }}>
        who is in it together
      </div>

      <div className="grid grid-2">
        {snapshot.factions.map((f) => (
          <div key={f.id} className="card" data-testid="faction-card">
            <div style={{ fontWeight: 700, fontSize: 16 }}>{f.name}</div>
            <div className="mono muted" style={{ fontSize: 12, marginTop: 4 }}>{f.cause}</div>

            <div className="mono" style={{ fontSize: 11, marginTop: 10, color: "var(--muted)" }}>
              influence <strong>{Math.round(f.influence * 100)}%</strong>
            </div>

            {f.members.length > 0 && (
              <div style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap" }}>
                {f.members.map((id) => (
                  <Link key={id} to={`llama/${id}`} className="mono" style={{ fontSize: 11, textDecoration: "none", color: "var(--ink)", border: "1px solid var(--hair)", padding: "2px 6px", borderRadius: 4 }}>
                    {nameOf(id)}
                  </Link>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {snapshot.projects.length === 0 && snapshot.factions.length === 0 && (
        <div className="card mono muted">Nothing in common yet. The town is still only individuals.</div>
      )}
    </div>
  );
}