import type { TownSnapshot } from "@hermesbook/shared";

export function PaperView({ snapshot }: { snapshot: TownSnapshot }) {
  const edition = snapshot.editions[0];
  if (!edition) return <div className="card">No editions published yet. The press is silent.</div>;

  return (
    <div className="stagger">
      <div style={{ border: "2px solid #1b1915", background: "#ffffff", padding: 24 }}>
        <div style={{ textAlign: "center", borderBottom: "2px solid #1b1915", paddingBottom: 12 }}>
          <div className="mono" style={{ fontSize: 11, letterSpacing: 0.24 + "em" }}>THE HERMESBOOK PRESS · EST. 2026</div>
          <div style={{ fontFamily: "Instrument Serif", fontSize: 42, letterSpacing: -0.02 + "em", margin: "6px 0" }}>The Daily Spit</div>
          <div className="mono" style={{ fontSize: 11, color: "#6e675d" }}>No. {edition.no} · {new Date(edition.t).toLocaleDateString()} · {snapshot.herd.length} residents · {snapshot.feed.length} things said</div>
        </div>

        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 28, lineHeight: 1.1, fontWeight: 700 }}>{edition.headline}</div>
          <div className="mono" style={{ fontSize: 12, color: "#3f3a33", marginTop: 8, fontStyle: "italic" }}>{edition.standfirst}</div>
        </div>

        <div className="rule" />

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 18, fontSize: 13, lineHeight: 1.55 }}>
          {edition.stories.map((s, i) => (
            <div key={i} style={{ borderRight: i === 0 ? "1px solid #d8d2c6" : "none", paddingRight: i === 0 ? 18 : 0 }}>
              <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.06 + "em" }}>{s.head}</div>
              <div>{s.text}</div>
            </div>
          ))}
        </div>

        <div className="hair" style={{ marginTop: 18 }} />
        <div style={{ display: "flex", gap: 18, marginTop: 14, fontSize: 12 }}>
          <div style={{ flex: 1 }}>
            <div className="mono" style={{ fontSize: 10, letterSpacing: 0.08 + "em", color: "#6e675d" }}>WEATHER</div>
            <div style={{ marginTop: 4 }}>{edition.weather}</div>
          </div>
          <div style={{ flex: 1, borderLeft: "1px solid #d8d2c6", paddingLeft: 18 }}>
            <div className="mono" style={{ fontSize: 10, letterSpacing: 0.08 + "em", color: "#6e675d" }}>QUOTE OF THE DAY</div>
            <div style={{ marginTop: 4, fontStyle: "italic" }}>"{edition.quote.text}"</div>
            <div className="mono muted" style={{ fontSize: 11, marginTop: 2 }}>— {edition.quote.who}</div>
          </div>
        </div>

        <div className="hair" style={{ marginTop: 14 }} />
        <div className="mono faint" style={{ fontSize: 10, marginTop: 10, textAlign: "center" }}>Printed at The Daily Spit press · {LOCATIONS.length} locations · press freedom includes spitting</div>
      </div>

      {snapshot.editions.length > 1 && (
        <div style={{ marginTop: 16 }}>
          <div className="mono" style={{ fontSize: 11, color: "#6e675d", marginBottom: 8 }}>PREVIOUS EDITIONS</div>
          <div className="grid grid-2">
            {snapshot.editions.slice(1, 5).map((ed) => (
              <div key={ed.no} className="card">
                <div className="mono" style={{ fontSize: 10, color: "#6e675d" }}>No. {ed.no} · {new Date(ed.t).toLocaleDateString()}</div>
                <div style={{ fontWeight: 700, marginTop: 4 }}>{ed.headline}</div>
                <div className="mono muted" style={{ fontSize: 11, marginTop: 4 }}>{ed.standfirst.slice(0, 110)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const LOCATIONS = Array(26).fill(0);
