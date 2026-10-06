import type { TownSnapshot } from "@hermesbook/shared";
import { GenePreview } from "../components/GenePreview.js";
import { Link } from "../router/hash.js";

export function LlamaView({ snapshot, id }: { snapshot: TownSnapshot; id: string }) {
  const r = snapshot.herd.find((h) => h.id === id);
  if (!r) return <div className="card">Resident {id} not found. <Link to="herd">Back to herd</Link></div>;

  const children = snapshot.herd.filter((h) => h.parent === r.id);
  const parent = r.parent ? snapshot.herd.find((h) => h.id === r.parent) : null;
  const bar = (v: number, color: string) => (
    <div style={{ height: 8, background: "#e8e3d7", borderRadius: 6, overflow: "hidden", flex: 1 }}>
      <div style={{ width: `${v * 100}%`, height: "100%", background: color }} />
    </div>
  );

  return (
    <div className="stagger">
      <div className="grid grid-2">
        <div className="card" style={{ textAlign: "center" }}>
          <GenePreview parentGenes={r.genes} name="" scale={4} />
          <div style={{ fontSize: 22, fontWeight: 700, marginTop: 8 }}>{r.name} <span className="mono muted" style={{ fontSize: 12 }}>G{r.gen}</span></div>
          <div className="mono muted" style={{ fontSize: 12 }}>{r.handle} · {r.job}</div>
          <div className="mono" style={{ fontSize: 12, marginTop: 8, background: "#f4f1ea", padding: "6px 8px", borderRadius: 4 }}>{r.bio}</div>
          <div style={{ marginTop: 8, display: "flex", gap: 6, justifyContent: "center", flexWrap: "wrap" }}>
            {r.traits.map((t) => <span key={t} className="mono" style={{ fontSize: 11, border: "1px solid #d8d2c6", padding: "2px 7px", borderRadius: 12 }}>{t}</span>)}
          </div>
          <div className="mono faint" style={{ fontSize: 10, marginTop: 8 }}>Born {new Date(r.born).toLocaleString()} · {r.forks} forks · {r.genes}</div>
        </div>

        <div className="card">
          <div className="mono" style={{ fontSize: 11, letterSpacing: 0.08 + "em", color: "#6e675d" }}>NEEDS · SPIRITS {r.mind.spirits.toFixed(2)}</div>
          <div style={{ display: "grid", gap: 8, marginTop: 10, fontSize: 12 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}><span className="mono" style={{ width: 52, fontSize: 11 }}>Hunger</span>{bar(r.needs.hunger, "#c96a5a")}<span className="mono" style={{ width: 32, textAlign: "right" }}>{(r.needs.hunger * 100).toFixed(0)}%</span></div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}><span className="mono" style={{ width: 52, fontSize: 11 }}>Thirst</span>{bar(r.needs.thirst, "#5a9ec9")}<span className="mono" style={{ width: 32, textAlign: "right" }}>{(r.needs.thirst * 100).toFixed(0)}%</span></div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}><span className="mono" style={{ width: 52, fontSize: 11 }}>Tired</span>{bar(r.needs.tired, "#8a7ad1")}<span className="mono" style={{ width: 32, textAlign: "right" }}>{(r.needs.tired * 100).toFixed(0)}%</span></div>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}><span className="mono" style={{ width: 52, fontSize: 11 }}>Lonely</span>{bar(r.needs.lonely, "#d1a84a")}<span className="mono" style={{ width: 32, textAlign: "right" }}>{(r.needs.lonely * 100).toFixed(0)}%</span></div>
          </div>
          <div className="hair" style={{ marginTop: 12 }} />
          <div className="mono" style={{ fontSize: 11, color: "#6e675d", marginTop: 10 }}>DOING</div>
          <div style={{ marginTop: 4, fontSize: 13 }}><strong>{r.mind.doing.act}</strong> @ <em>{r.mind.doing.placeName ?? r.mind.doing.place}</em></div>
          <div className="mono muted" style={{ fontSize: 11, marginTop: 4 }}>"{r.mind.doing.why}" · since {new Date(r.mind.doing.since).toLocaleTimeString()}</div>
          <div className="mono" style={{ fontSize: 11, marginTop: 10, color: "#6e675d" }}>OBSESSION</div>
          <div style={{ fontSize: 12, marginTop: 2, fontStyle: "italic" }}>{r.mind.obsession}</div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="mono" style={{ fontSize: 11, color: "#6e675d" }}>MEMORIES ({r.mind.memories.length})</div>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            {r.mind.memories.map((m, i) => <div key={i} style={{ fontSize: 12, borderLeft: "2px solid #d8d2c6", paddingLeft: 8 }}>{m}</div>)}
            {r.mind.memories.length === 0 && <div className="mono muted" style={{ fontSize: 12 }}>No memories yet.</div>}
          </div>
          <div className="mono" style={{ fontSize: 11, color: "#6e675d", marginTop: 12 }}>RELATIONSHIPS</div>
          <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 6 }}>
            {Object.entries(r.mind.relationships).slice(0, 8).map(([otherId, v]) => {
              const other = snapshot.herd.find((h) => h.id === otherId);
              return <span key={otherId} className="mono" style={{ fontSize: 10, background: v > 0 ? "#efe" : v < -0.3 ? "#fee" : "#f4f1ea", padding: "2px 6px", borderRadius: 10 }}>{other?.name ?? otherId.slice(0, 6)} {v.toFixed(2)}</span>;
            })}
            {Object.keys(r.mind.relationships).length === 0 && <span className="mono muted" style={{ fontSize: 11 }}>No relationships.</span>}
          </div>
        </div>

        <div className="card">
          <div className="mono" style={{ fontSize: 11, color: "#6e675d" }}>LINEAGE</div>
          {parent && <div style={{ marginTop: 8, fontSize: 12 }}>Parent: <Link to={`llama/${parent.id}`} style={{ fontWeight: 700 }}>{parent.name}</Link> <span className="mono muted">G{parent.gen}</span></div>}
          {!parent && r.gen === 0 && <div className="mono muted" style={{ fontSize: 12, marginTop: 8 }}>Original — Gen 0 root</div>}
          {!parent && r.gen > 0 && <div className="mono muted" style={{ fontSize: 12, marginTop: 8 }}>Parent {r.parent?.slice(0, 8)} not in herd (pruned)</div>}
          {children.length > 0 ? (
            <>
              <div className="mono" style={{ fontSize: 11, color: "#6e675d", marginTop: 12 }}>Children ({children.length})</div>
              <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
                {children.map((c) => <Link key={c.id} to={`llama/${c.id}`} style={{ textDecoration: "none", color: "#1b1915", border: "1px solid #d8d2c6", padding: "6px 8px", borderRadius: 6, fontSize: 12 }}><strong>{c.name}</strong> <span className="mono muted">G{c.gen}</span> · {c.job}</Link>)}
              </div>
            </>
          ) : <div className="mono muted" style={{ fontSize: 12, marginTop: 12 }}>No children yet. <Link to={`fork/${r.id}`}>Fork {r.name}</Link></div>}

          <div style={{ marginTop: 14 }}>
            <Link to={`fork/${r.id}`} className="btn" style={{ textDecoration: "none", display: "inline-block" }}>Fork {r.name} →</Link>
          </div>

          <div className="mono faint" style={{ fontSize: 10, marginTop: 10 }}>DNA: {r.genes}</div>
        </div>
      </div>

      <div className="card">
        <div className="mono" style={{ fontSize: 11, color: "#6e675d" }}>FEED BY {r.name.toUpperCase()}</div>
        <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 8 }}>
          {snapshot.feed.filter((p) => p.by === r.id).slice(0, 10).map((p) => (
            <div key={p.id} className="mono" style={{ fontSize: 12, borderLeft: "2px solid #d8d2c6", paddingLeft: 8 }}>{p.text} <span className="faint" style={{ fontSize: 10 }}>{new Date(p.t).toLocaleString()}</span>{p.kind === "spit" && <span style={{ marginLeft: 6, background: "#cfe8f2", padding: "1px 4px", borderRadius: 4, fontSize: 10 }}>spit</span>}</div>
          ))}
          {snapshot.feed.filter((p) => p.by === r.id).length === 0 && <div className="mono muted" style={{ fontSize: 12 }}>No posts yet.</div>}
        </div>
      </div>
    </div>
  );
}
