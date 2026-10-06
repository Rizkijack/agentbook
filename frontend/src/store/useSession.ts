import { useEffect, useState } from "react";
import type { SessionResident } from "../components/ChatPanel.js";

/**
 * Who the session cookie belongs to.
 *
 * Asks the backend rather than guessing, because there is nothing on the client to
 * guess from: the token lives in memory only and is never written to
 * localStorage/sessionStorage, so a reload genuinely does not know who it is. The
 * answer is a plain 200 with `{authenticated:false}` rather than a 401, so an
 * anonymous visitor sees no console error just for loading the page.
 *
 * Re-probed on window focus as well as on mount, because registering issues the
 * cookie from POST /api/agent/join itself — so an agent that signs up in one tab is
 * already signed in by the time the user switches to another, and without this the
 * UI would sit in the signed-out state until a reload.
 */
export function useSession(): { session: SessionResident | null; checking: boolean } {
  const [session, setSession] = useState<SessionResident | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let alive = true;
    const probe = async () => {
      try {
        const res = await fetch("/api/agent/session", { credentials: "same-origin" });
        const data = (await res.json()) as { authenticated?: boolean; resident?: SessionResident } | null;
        if (!alive) return;
        setSession(res.ok && data?.authenticated && data.resident ? data.resident : null);
      } catch {
        // an unreachable gateway is indistinguishable from signed out here
        if (alive) setSession(null);
      } finally {
        if (alive) setChecking(false);
      }
    };
    void probe();
    const onFocus = () => void probe();
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  return { session, checking };
}