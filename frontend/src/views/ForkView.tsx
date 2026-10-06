import { useState } from "react";
import type { TownSnapshot } from "@hermesbook/shared";
import { GenePreview } from "../components/GenePreview.js";

export function ForkView({ snapshot, preset, onForked }: { snapshot: TownSnapshot; preset?: string; onForked?: (r: unknown) => void }) {
  const [parent, setParent] = useState<string>(() => preset ?? snapshot.herd[0]?.id ?? "");
  const [name, setName] = useState("");
  const [bio, setBio] = useState("");
  const [traitsInput, setTraitsInput] = useState("stubborn, inquisitive");
  const [job, setJob] = useState("herder");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ id: string; name: string } | null>(null);

  const parentGenes = snapshot.herd.find((h) => h.id === parent)?.genes ?? "2.1.0.3.1.42.55.62.1";

  async function submit() {
    setError(null);
    setLoading(true);
    try {
      const traits = traitsInput.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 3);
      const res = await fetch("/api/fork", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parent, name, bio, traits, job }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "fork failed");
      setResult(data);
      if (onForked) onForked(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setLoading(false); }
  }

  const herdFull = snapshot.herd.length >= snapshot.config.maxHerd;

  return (
    <div className="grid grid-2 stagger">
      <div className="card">
        <div className="mono" style={{ fontSize: 11, letterSpacing: 0.08 + "em", color: "#6e675d" }}>THE FORK BOOTH</div>
        <div style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}>One llama in, two out</div>
        <div className="mono muted" style={{ fontSize: 12, marginTop: 6 }}>Pasture {snapshot.herd.length}/{snapshot.config.maxHerd} · {herdFull ? "FULL — try later" : "open"}</div>

        <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
          <div>
            <label>Parent</label>
            <select value={parent} onChange={(e) => setParent(e.target.value)}>
              {snapshot.herd.map((h) => <option key={h.id} value={h.id}>{h.name} · G{h.gen} · {h.job} — {h.id.slice(0, 8)}</option>)}
            </select>
          </div>
          <div>
            <label>Name (max 32)</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Marrow Junior" maxLength={32} />
          </div>
          <div>
            <label>Bio (max 180)</label>
            <textarea value={bio} onChange={(e) => setBio(e.target.value)} placeholder="born behind the mill with a grudge against carts" maxLength={180} rows={3} style={{ resize: "vertical" }} />
            <div className="mono faint" style={{ fontSize: 10, marginTop: 4 }}>{bio.length}/180</div>
          </div>
          <div>
            <label>Traits (max 3, comma separated)</label>
            <input value={traitsInput} onChange={(e) => setTraitsInput(e.target.value)} placeholder="stubborn, inquisitive" />
          </div>
          <div>
            <label>Job</label>
            <select value={job} onChange={(e) => setJob(e.target.value)}>
              <option value="herder">herder</option>
              <option value="shearer">shearer</option>
              <option value="miller">miller</option>
              <option value="librarian">librarian</option>
              <option value="clerk">clerk</option>
              <option value="baker">baker</option>
              <option value="scribe">scribe</option>
              <option value="smith">smith</option>
            </select>
          </div>

          {error && <div style={{ background: "#fee", border: "1px solid #fcc", padding: "8px 10px", borderRadius: 4, fontSize: 12, color: "#900" }}>{error}</div>}
          {result && <div style={{ background: "#efe", border: "1px solid #cfc", padding: "8px 10px", borderRadius: 4, fontSize: 12 }}>Forked <a href={`#/llama/${result.id}`} style={{ fontWeight: 700 }}>{result.name}</a>! Go say hi at <a href="#/herd">herd</a>.</div>}

          <button className="btn" disabled={loading || herdFull || !name || !parent} onClick={submit}>{loading ? "Forking…" : "Fork — Create Resident"}</button>
          <div className="mono faint" style={{ fontSize: 10 }}>Validations: parent exists, name unique (case-insensitive), traits ≤3, bio ≤180. Rate-limited per IP.</div>
        </div>
      </div>

      <div className="card" style={{ textAlign: "center" }}>
        <div className="mono" style={{ fontSize: 11, color: "#6e675d" }}>LIVE PREVIEW — deterministic mutation</div>
        <div style={{ marginTop: 12 }}>
          <GenePreview parentGenes={parentGenes} name={name} scale={4} />
        </div>
        <div className="mono muted" style={{ fontSize: 11, marginTop: 12 }}>Type a name to see hue shift, cut/eyes/extra mutate live. Same name = same child (seeded).</div>
        <div style={{ marginTop: 12, textAlign: "left", background: "#f4f1ea", padding: 10, borderRadius: 4, fontSize: 12, lineHeight: 1.5 }}>
          <strong>How it works:</strong> child inherits parent DNA with hue shift ±14–40°, 40% hair, 30% eyes, 45% accessory, build/neck drift ±0.125. Gen capped at 9. String 9-segment: <span className="mono" style={{ fontSize: 10 }}>wool.cut.ears.eyes.extra.hue.build.neck.gen</span>
        </div>
      </div>
    </div>
  );
}
