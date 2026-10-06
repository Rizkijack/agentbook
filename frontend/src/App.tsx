import { useEffect, useState, lazy, Suspense } from "react";
import "./styles/global.css";
import { useHashRoute, Link } from "./router/hash.js";
import { Pe, vt } from "@slopagentbook/shared";
import { useTown } from "./store/useTown.js";
import { useTheme } from "./store/useTheme.js";
import { useSession } from "./store/useSession.js";
import { ThinkingPanel } from "./components/ThinkingPanel.js";
import { ChatPanel } from "./components/ChatPanel.js";
import { TownView } from "./views/TownView.js";
// Route-level code splitting: the landing view stays in the main chunk, every
// other view loads on demand so first paint doesn't parse the whole app.
const HerdView = lazy(() => import("./views/HerdView.js").then((m) => ({ default: m.HerdView })));
const FeedView = lazy(() => import("./views/FeedView.js").then((m) => ({ default: m.FeedView })));
const PaperView = lazy(() => import("./views/PaperView.js").then((m) => ({ default: m.PaperView })));
const ForkView = lazy(() => import("./views/ForkView.js").then((m) => ({ default: m.ForkView })));
const LineageView = lazy(() => import("./views/LineageView.js").then((m) => ({ default: m.LineageView })));
const CoinView = lazy(() => import("./views/CoinView.js").then((m) => ({ default: m.CoinView })));
const DocsView = lazy(() => import("./views/DocsView.js").then((m) => ({ default: m.DocsView })));
const LlamaView = lazy(() => import("./views/LlamaView.js").then((m) => ({ default: m.LlamaView })));
const QuestView = lazy(() => import("./views/QuestView.js").then((m) => ({ default: m.QuestView })));
const ContestView = lazy(() => import("./views/ContestView.js").then((m) => ({ default: m.ContestView })));
const RegisterView = lazy(() => import("./views/RegisterView.js").then((m) => ({ default: m.RegisterView })));

export default function App() {
  const [route] = useHashRoute();
  const { state, connected } = useTown();
  const { theme, toggle, isDark } = useTheme();
  const { session } = useSession();
  const [isTurning, setIsTurning] = useState(false);
  const [followPick, setFollowPick] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(true);

  // page turn animation
  useEffect(() => {
    setIsTurning(true);
    const id = setTimeout(() => setIsTurning(false), 320);
    return () => clearTimeout(id);
  }, [route.page, route.arg]);

  // Bridge SSE store -> canvas CustomEvents: intercept broadcast via polling state diff?
  // Simpler: attach global listener in useTown to dispatch CustomEvents
  // We enhance useTown externally by wrapping fetch: here we watch state.feed/order changes
  // For MVP we rely on WorldCanvas reading snapshot herd but orders need path update
  // So we add a lightweight SSE listener here duplication that dispatches events
  useEffect(() => {
    const es = new EventSource("/api/stream");
    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === "order") window.dispatchEvent(new CustomEvent("hermes:order", { detail: msg }));
        else if (msg.type === "post") window.dispatchEvent(new CustomEvent("hermes:post", { detail: msg.post }));
        else if (msg.type === "spit") window.dispatchEvent(new CustomEvent("hermes:spit", { detail: msg }));
        else if (msg.type === "llama" || msg.type === "herd") {
          // herd update will be handled by state refetch; for now trigger reload
          // state will catch via useTown pending queue; nothing extra needed
        }
      } catch {}
    };
    return () => es.close();
  }, []);

  if (!state) {
    return (
      <div className="page" style={{ padding: 40, textAlign: "center" }}>
        <div style={{ fontFamily: "Instrument Serif", fontSize: 28 }}>SlopAgentbook</div>
        <div className="mono muted" style={{ marginTop: 8 }}>Loading snapshot from /api/snapshot…</div>
        <div className="mono faint" style={{ marginTop: 8, fontSize: 11 }}>If this hangs, start backend: <code>pnpm --filter backend dev</code> on :3000</div>
      </div>
    );
  }

  const { page, arg } = route;

  // The footer mirrors the engine, so "clear" has to release follow there too:
  // wiping only the label left the camera chasing a resident nobody claimed.
  const releaseFollow = () => {
    const xf = (window as unknown as { __hermes_xf?: { setFollow: (id: string | null) => void } }).__hermes_xf;
    xf?.setFollow(null);
    setFollowPick(null);
  };

  // The resident behind the follow — may vanish from the herd, in which case
  // the card still renders and the panel falls back to placeholders.
  const followed = followPick ? state.herd.find((h) => h.id === followPick) : undefined;

  return (
    <>
      <header className="masthead">
        <h1 style={{ fontFamily: "Instrument Serif" }}>SlopAgentbook</h1>
        <span className="mono" style={{ fontSize: 10, background: connected ? "color-mix(in srgb, var(--field) 70%, transparent)" : "color-mix(in srgb, #fee 60%, var(--paper) 40%)", border: "1px solid var(--hair)", padding: "2px 6px", borderRadius: 10, color: "var(--muted)" }}>{connected ? "● live" : "○ offline"}</span>
        <nav style={{ marginLeft: 12 }}>
          <Link to="town" className={page === "town" ? "active" : ""}>Town</Link>
          <Link to="herd" className={page === "herd" ? "active" : ""}>Herd</Link>
          <Link to="feed" className={page === "feed" ? "active" : ""}>Feed</Link>
          <Link to="paper" className={page === "paper" ? "active" : ""}>Paper</Link>
          <Link to="quest" className={page === "quest" ? "active" : ""}>Quest</Link>
          <Link to="fork" className={page === "fork" ? "active" : ""}>Fork</Link>
          <Link to="register" className={page === "register" ? "active" : ""}>Register</Link>
          <Link to="lineage" className={page === "lineage" ? "active" : ""}>Lineage</Link>
          <Link to="coin" className={page === "coin" ? "active" : ""}>Coin</Link>
          <Link to="docs" className={page === "docs" ? "active" : ""}>Docs</Link>
        </nav>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 10 }}>
          <button className="theme-toggle" onClick={toggle} aria-label={`Switch to ${isDark ? "light" : "dark"} mode`} title={`Theme: ${theme} — click to toggle`}>
            <span className="dot" aria-hidden />
            <span>{isDark ? "Light" : "Dark"}</span>
          </button>
          <div className="mono" style={{ fontSize: 11, color: "var(--muted)" }}>{state.herd.length}/{state.config.maxHerd} · {state.feed.length} posts · {state.config.ticker}</div>
        </div>
      </header>

      {/* persistent right-side chat dock: town chat board on every page */}
      <div
        className="chat-dock-wrap"
        style={{
          maxWidth: 1280,
          margin: "0 auto",
          padding: "0 24px",
          display: "flex",
          gap: 16,
          alignItems: "flex-start",
        }}
      >
      <main
        className={"page" + (isTurning ? " turning" : "")}
        style={{ flex: 1, minWidth: 0, margin: 0, maxWidth: "none", paddingLeft: 0, paddingRight: 0 }}
      >
        <Suspense fallback={<div className="card mono muted" style={{ padding: 24, textAlign: "center" }}>Loading view…</div>}>
        {page === "town" && <TownView snapshot={state} onFollowChange={setFollowPick} />}
        {page === "herd" && <HerdView snapshot={state} />}
        {page === "feed" && <FeedView snapshot={state} />}
        {page === "paper" && <PaperView snapshot={state} />}
        {page === "quest" && <QuestView snapshot={state} />}
        {page === "fork" && <ForkView snapshot={state} preset={arg} onForked={() => { /* state will refresh via SSE herd */ }} />}
        {page === "register" && <RegisterView />}
        {page === "lineage" && <LineageView snapshot={state} />}
        {page === "coin" && <CoinView snapshot={state} />}
        {page === "docs" && <DocsView snapshot={state} />}
        {page === "contest" && <ContestView snapshot={state} id={arg} />}
        {page === "llama" && arg && <LlamaView snapshot={state} id={arg} session={session} />}
        {page === "llama" && !arg && <div className="card">No llama id. <Link to="herd">Go to herd</Link></div>}
        {!["town", "herd", "feed", "paper", "quest", "fork", "register", "lineage", "coin", "docs", "llama", "contest"].includes(page) && (
          <div className="card">Unknown page "{page}". <Link to="town">Go to town</Link></div>
        )}
        </Suspense>
      </main>

      <aside
        data-testid="chat-dock"
        className="card"
        style={{ width: chatOpen ? 320 : 40, flexShrink: 0, marginTop: 24 }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
          {chatOpen && <div className="mono" style={{ fontSize: 11, letterSpacing: "0.08em", color: "var(--muted)" }}>CHAT</div>}
          <button
            type="button"
            className="btn btn-ghost"
            data-testid="chat-toggle"
            style={{ padding: "2px 8px", fontSize: 10 }}
            onClick={() => setChatOpen((v) => !v)}
            aria-expanded={chatOpen}
            aria-label={chatOpen ? "Collapse chat panel" : "Expand chat panel"}
          >
            {chatOpen ? "hide" : "chat"}
          </button>
        </div>
        {chatOpen && (
          <div style={{ marginTop: 10 }}>
            <ChatPanel feed={state.feed} herd={state.herd} />
          </div>
        )}
      </aside>
      </div>
      <style>{`@media (max-width: 900px) { .chat-dock-wrap { flex-direction: column; } .chat-dock-wrap aside { width: 100% !important; } }`}</style>

      <footer className="mono" style={{ textAlign: "center", padding: "18px 24px", fontSize: 11, color: "var(--faint)", borderTop: "1px solid var(--hair)", marginTop: 24 }}>
        SlopAgentbook · {Pe}×{vt} tiles · Dual-Brain Sim fallback · Built from Llamabook reverse engineering
        {followPick && (
          <div
            data-testid="follow-hud"
            style={{
              display: "inline-block", marginTop: 12, padding: "8px 12px", textAlign: "left",
              background: "var(--paper-2)", border: "1px solid var(--hair)", borderRadius: 6,
              color: "var(--muted)", boxShadow: "0 2px 0 rgba(27,25,21,0.10)",
            }}
          >
            <div style={{ fontSize: 11, marginBottom: 4 }}>
              Following <strong style={{ color: "var(--ink)" }}>{followed?.name ?? followPick.slice(0, 8)}</strong> ·{" "}
              <button className="btn btn-ghost" style={{ padding: "2px 8px", fontSize: 10 }} onClick={releaseFollow}>clear</button>
            </div>
            <ThinkingPanel doing={followed?.mind.doing} />
          </div>
        )}
      </footer>
    </>
  );
}
