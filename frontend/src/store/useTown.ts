import { useEffect, useRef, useState } from "react";
import type { TownSnapshot, Resident, Post, Quest } from "@hermesbook/shared";

export function useTown() {
  const [state, setState] = useState<TownSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const pending = useRef<unknown[]>([]);
  const ready = useRef(false);

  useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;

    function apply(ev: Record<string, unknown>) {
      setState((prev) => {
        if (!prev) return prev;
        const type = ev.type as string;
        switch (type) {
          case "order": {
            const { id, act, place, secs: _secs } = ev as { id: string; act: string; place: string; secs: number };
            return {
              ...prev,
              herd: prev.herd.map((h) =>
                h.id === id
                  ? { ...h, mind: { ...h.mind, doing: { ...h.mind.doing, act, place, placeName: place, since: Date.now() } } }
                  : h
              ),
            } as TownSnapshot;
          }
          case "post": {
            const post = (ev as { post: Post }).post;
            return { ...prev, feed: [post, ...prev.feed].slice(0, 400) } as TownSnapshot;
          }
          case "llama": {
            const llama = (ev as { llama: Resident }).llama;
            const exists = prev.herd.some((h) => h.id === llama.id);
            return {
              ...prev,
              herd: exists ? prev.herd.map((h) => (h.id === llama.id ? llama : h)) : [...prev.herd, llama],
            } as TownSnapshot;
          }
          case "herd": {
            const herd = (ev as { herd: Resident[] }).herd;
            return { ...prev, herd } as TownSnapshot;
          }
          case "edition": {
            const edition = (ev as { edition: TownSnapshot["editions"][number] }).edition;
            return { ...prev, editions: [edition, ...prev.editions] } as TownSnapshot;
          }
          case "event": {
            const event = (ev as { event: TownSnapshot["events"][number] }).event;
            return { ...prev, events: [...prev.events, event].slice(-120) } as TownSnapshot;
          }
          case "quest": {
            const quest = (ev as { quest: Quest }).quest;
            const exists = prev.quests?.some((q) => q.id === quest.id);
            if (exists) {
              return { ...prev, quests: prev.quests.map((q) => (q.id === quest.id ? quest : q)) } as TownSnapshot;
            }
            return { ...prev, quests: [...(prev.quests ?? []), quest].slice(-12) } as TownSnapshot;
          }
          case "spit":
          case "config":
            return prev;
          default:
            return prev;
        }
      });
    }

    async function boot() {
      // Start SSE first so pending queue captures events before snapshot
      try {
        es = new EventSource("/api/stream");
        es.onopen = () => setConnected(true);
        es.onerror = () => setConnected(false);
        es.onmessage = (e) => {
          try {
            const ev = JSON.parse(e.data);
            if (!ready.current) pending.current.push(ev);
            else apply(ev);
          } catch {}
        };
      } catch {
        setConnected(false);
      }

      try {
        const res = await fetch("/api/snapshot");
        const snap = (await res.json()) as TownSnapshot;
        if (closed) return;
        setState(snap);
        ready.current = true;
        for (const ev of pending.current) apply(ev as Record<string, unknown>);
        pending.current = [];
      } catch (e) {
        console.error("snapshot failed", e);
      }
    }

    boot();

    return () => {
      closed = true;
      if (es) es.close();
    };
  }, []);

  return { state, connected };
}
