import { useEffect, useState, useCallback } from "react";

export type Theme = "light" | "dark";

function getPreferred(): Theme {
  if (typeof window === "undefined") return "light";
  const saved = localStorage.getItem("hermes:theme") as Theme | null;
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(getPreferred);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-theme", theme);
    // also set color-scheme for native inputs
    root.style.colorScheme = theme;
    localStorage.setItem("hermes:theme", theme);
  }, [theme]);

  useEffect(() => {
    // listen to system changes if no explicit saved preference? we still respect saved, but also update if user hasn't manually toggled recently?
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => {
      const saved = localStorage.getItem("hermes:theme");
      // only follow system if user hasn't manually set? we keep manual as override, but if they clear storage, follow system
      if (!saved) setTheme(e.matches ? "dark" : "light");
    };
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  const toggle = useCallback(() => {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  const set = useCallback((t: Theme) => setTheme(t), []);

  return { theme, toggle, set, isDark: theme === "dark" };
}
