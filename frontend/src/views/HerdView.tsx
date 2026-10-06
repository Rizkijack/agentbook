import { useState, useMemo } from "react";
import type { TownSnapshot } from "@hermesbook/shared";
import { GenePreview } from "../components/GenePreview.js";
import { Link } from "../router/hash.js";

type Filter = "all" | "working" | "talking" | "forks" | "originals" | "oldest";

export function HerdView({ snapshot }: { snapshot: TownSnapshot }) {
  const [filter, setFilter] = useState<Filter>("all");

  const sorted = useMemo(() => {
    let arr = [...snapshot.herd];
    switch (filter) {
      case "working": arr = arr.filter((h) => h.mind.doing.act === "work"); break;
      case "talking": arr = arr.filter((h) => h.mind.doing.act === "talk" || h.mind.doing.act === "argue"); break;
      case "forks": arr = arr.filter((h) => (h.gen ?? 0) > 0); break;
      case "originals": arr = arr.filter((h) => (h.gen ?? 0) === 0); break;
      case "oldest": arr = [...arr].sort((a, b) => a.born - b.born); break;
      default: break;
    }
    if (filter !== "oldest") arr.sort((a, b) => a.name.localeCompare(b.name));
    return arr;
  }, [snapshot.herd, filter]);

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        {(["all", "working", "talking", "forks", "originals", "oldest"] as const).map((f) => (
          <button key={f} className={filter === f ? "btn" : "btn btn-ghost"} style={{ padding: "6px 10px" }} onClick={() => setFilter(f)}>{f}</button>
        ))}
        <span className="mono muted" style={{ alignSelf: "center", marginLeft: 8, fontSize: 11 }}>{sorted.length} residents</span>
      </div>

      <div className="grid grid-3 stagger">
        {sorted.map((h) => (
          <Link key={h.id} to={`llama/${h.id}`} className="card" style={{ textDecoration: "none", color: "inherit" }}>
            <div style={{ display: "flex", gap: 12 }}>
              <GenePreview parentGenes={h.genes} name="" scale={1.15} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 16, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{h.name} <span className="mono muted" style={{ fontSize: 11 }}>G{h.gen}</span></div>
                <div className="mono muted" style={{ fontSize: 11 }}>{h.handle} · {h.job}</div>
                <div className="mono" style={{ fontSize: 11, marginTop: 6, background: "#f4f1ea", padding: "2px 6px", borderRadius: 4, display: "inline-block" }}>{h.mind.doing.act} @ {h.mind.doing.place}</div>
                <div className="mono faint" style={{ fontSize: 10, marginTop: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{h.bio}</div>
                <div style={{ marginTop: 8, display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {h.traits.map((t) => <span key={t} className="mono" style={{ fontSize: 10, border: "1px solid #d8d2c6", padding: "1px 5px", borderRadius: 4 }}>{t}</span>)}
                </div>
              </div>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
