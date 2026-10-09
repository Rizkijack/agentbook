// Node 22+ ships an experimental global `localStorage` getter that returns
// undefined unless --localstorage-file was passed. Vitest's jsdom environment
// creates proper stores, but Node's getter on globalThis *replaces* jsdom's, so
// any test calling `localStorage.clear()` crashes with
// "Cannot read properties of undefined". Re-define both globals with jsdom's
// actual Storage instances so test code sees the same web storage the React
// app uses.
import { beforeAll } from "vitest";

// Minimal in-memory Storage — the tests only need clear/get/setItem/removeItem
// and the iterable length/key behaviour for the "keeps the token out of web
// storage" assertions.
function makeStorage(): Storage {
  const map = new Map<string, string>();
  const store: Storage = {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    removeItem: (k: string) => {
      map.delete(k);
    },
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
  };
  return store;
}

beforeAll(() => {
  const w = globalThis.window as (Window & typeof globalThis) | undefined;
  const targets = [globalThis, w].filter(Boolean) as (Window & typeof globalThis)[];

  for (const target of targets) {
    if (typeof target.localStorage === "undefined") {
      Object.defineProperty(target, "localStorage", {
        configurable: true,
        get: () => ls,
      });
    }
    if (typeof target.sessionStorage === "undefined") {
      Object.defineProperty(target, "sessionStorage", {
        configurable: true,
        get: () => ss,
      });
    }
  }
});

const ls = makeStorage();
const ss = makeStorage();
