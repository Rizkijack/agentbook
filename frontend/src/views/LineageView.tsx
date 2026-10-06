import type { TownSnapshot, Resident } from "@hermesbook/shared";
import { Link } from "../router/hash.js";

function buildTree(herd: Resident[]): Map<string, Resident[]> {
  const byParent = new Map<string, Resident[]>();
  for (const h of herd) {
    if (h.parent) {
      if (!byParent.has(h.parent)) byParent.set(h.parent, []);
      byParent.get(h.parent)!.push(h);
    }
  }
  return byParent;
}

export function LineageView({ snapshot }: { snapshot: TownSnapshot }) {
  const byParent = buildTree(snapshot.herd);
  const roots = snapshot.herd.filter((h) => !h.parent || !snapshot.herd.some((p) => p.id === h.parent));

  function renderNode(h: Resident, depth: number, isLast: boolean): JSX.Element {
    const children = byParent.get(h.id) ?? [];
    const prefix = depth === 0 ? "" : isLast ? "└─" : "├─";
    return (
      <div key={h.id} style={{ marginLeft: depth * 18 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "4px 0", borderBottom: "1px solid #f0ebe0" }}>
          <span className="mono faint" style={{ fontSize: 11, minWidth: 22 }}>{prefix}</span>
          <Link to={`llama/${h.id}`} style={{ fontWeight: 700, textDecoration: "none", color: "#1b1915" }}>{h.name}</Link>
          <span className="mono" style={{ fontSize: 10, background: h.gen === 0 ? "#1b1915" : "#e8e3d7", color: h.gen === 0 ? "#fff" : "#1b1915", padding: "1px 6px", borderRadius: 10 }}>G{h.gen}</span>
          <span className="mono muted" style={{ fontSize: 11 }}>{h.job}</span>
          <span className="mono faint" style={{ fontSize: 10, marginLeft: "auto" }}>{h.mind.obsession.slice(0, 32)}</span>
          <span className="mono faint" style={{ fontSize: 10 }}>{children.length} forks</span>
        </div>
        {children.map((c, i) => renderNode(c, depth + 1, i === children.length - 1))}
      </div>
    );
  }

  return (
    <div>
      <div className="mono" style={{ fontSize: 11, color: "#6e675d", marginBottom: 12 }}>LINEAGE — Gen 0 to Gen 9 · {snapshot.herd.length} total · {roots.length} roots</div>
      <div className="card">
        {roots.map((r, i) => renderNode(r, 0, i === roots.length - 1))}
        {roots.length === 0 && <div className="mono muted">No lineage yet.</div>}
      </div>
      <div className="mono faint" style={{ fontSize: 10, marginTop: 8 }}>Fork creates child with hue shift ±14–40°, random cut/eyes/extra, drift build/neck. Deterministic per name seed.</div>
    </div>
  );
}
