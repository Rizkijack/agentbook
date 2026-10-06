import { useEffect, useState } from "react";
import type { TownSnapshot } from "@hermesbook/shared";

export function CoinView({ snapshot }: { snapshot: TownSnapshot }) {
  const [treasury, setTreasury] = useState<{ sol: number; solUsd: number; usd: number; updated: number; address: string; chainName: string } | null>(null);

  useEffect(() => {
    let alive = true;
    async function fetchTreasury() {
      try {
        const r = await fetch("/api/treasury");
        const j = await r.json();
        if (alive) setTreasury(j);
      } catch {}
    }
    fetchTreasury();
    const id = setInterval(fetchTreasury, 60_000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  return (
    <div className="stagger">
      <div className="card" style={{ background: "#1b1915", color: "#f4f1ea", borderColor: "#1b1915" }}>
        <div className="mono" style={{ fontSize: 11, letterSpacing: 0.12 + "em", opacity: 0.7 }}>${snapshot.config.ticker} · {snapshot.config.chainName} · {snapshot.config.network}</div>
        <div style={{ fontSize: 28, fontWeight: 700, marginTop: 6 }}>Hermesbook Treasury</div>
        <div className="mono" style={{ fontSize: 11, opacity: 0.75, marginTop: 6, wordBreak: "break-all" }}>{snapshot.config.tokenAddress}</div>
        <div style={{ marginTop: 14, display: "flex", gap: 12, flexWrap: "wrap" }}>
          <a className="btn" style={{ background: "#f4f1ea", color: "#1b1915", borderColor: "#f4f1ea", textDecoration: "none" }} href={snapshot.config.explorer} target="_blank" rel="noreferrer">Explorer ↗</a>
          <a className="btn btn-ghost" style={{ borderColor: "#f4f1ea", color: "#f4f1ea", textDecoration: "none" }} href={snapshot.config.dexUrl} target="_blank" rel="noreferrer">Dexscreener ↗</a>
          <a className="mono" style={{ alignSelf: "center", fontSize: 11, opacity: 0.7, color: "#f4f1ea" }} href={snapshot.config.xUrl} target="_blank" rel="noreferrer">{snapshot.config.xUrl}</a>
        </div>
      </div>

      <div className="grid grid-3">
        <div className="card">
          <div className="mono" style={{ fontSize: 11, color: "#6e675d" }}>TREASURY (cached 60s)</div>
          {treasury ? (
            <>
              <div style={{ fontSize: 22, fontWeight: 700, marginTop: 8 }}>{treasury.sol.toFixed(4)} {treasury.chainName === "Base" ? "ETH" : "SOL"}</div>
              <div className="mono muted" style={{ fontSize: 12 }}>${treasury.solUsd.toFixed(2)} each → ${treasury.usd.toFixed(2)} USD</div>
              <div className="mono faint" style={{ fontSize: 10, marginTop: 6 }}>updated {new Date(treasury.updated).toLocaleString()}</div>
            </>
          ) : <div className="mono muted">Loading treasury…</div>}
        </div>
        <div className="card">
          <div className="mono" style={{ fontSize: 11, color: "#6e675d" }}>HERD CAPACITY</div>
          <div style={{ fontSize: 22, fontWeight: 700, marginTop: 8 }}>{snapshot.herd.length} / {snapshot.config.maxHerd}</div>
          <div style={{ marginTop: 8, height: 6, background: "#e8e3d7", borderRadius: 6, overflow: "hidden" }}>
            <div style={{ width: `${(snapshot.herd.length / snapshot.config.maxHerd) * 100}%`, height: "100%", background: "#1b1915" }} />
          </div>
          <div className="mono faint" style={{ fontSize: 10, marginTop: 6 }}>{snapshot.config.maxHerd - snapshot.herd.length} spots left · fork cost: {snapshot.config.forkCost}</div>
        </div>
        <div className="card">
          <div className="mono" style={{ fontSize: 11, color: "#6e675d" }}>CONNECT WALLET</div>
          <div className="mono muted" style={{ fontSize: 12, marginTop: 8 }}>Base EVM — window.ethereum</div>
          <button className="btn" style={{ marginTop: 10, width: "100%" }} onClick={async () => {
            const eth = (window as unknown as { ethereum?: { request: (o: unknown) => Promise<string[]> } }).ethereum;
            if (!eth) { alert("No wallet found. Install MetaMask / Rabby with Base network."); return; }
            try { const accs = await eth.request({ method: "eth_requestAccounts" }); alert("Connected: " + accs[0]); } catch (e) { alert(String(e)); }
          }}>Connect Base Wallet</button>
          <div className="mono faint" style={{ fontSize: 10, marginTop: 6 }}>via window.ethereum · switched from Solana per Hermes adaptation</div>
        </div>
      </div>

      <div className="card">
        <div className="mono" style={{ fontSize: 11, color: "#6e675d" }}>ABOUT $HERMES</div>
        <div style={{ fontSize: 13, lineHeight: 1.6, marginTop: 8 }}>
          Hermesbook is the Hermes-town simulation — server-authoritative, real-time, zero-downtime dual-brain (LLM → Sim fallback). The treasury address holds the town's on-chain reserves, refreshed every 60s from RPC cache.
        </div>
      </div>
    </div>
  );
}
