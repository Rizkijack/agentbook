import { useEffect, useState } from "react";

export interface Route {
  page: string;
  arg?: string;
}

export function parseHash(hash: string): Route {
  const clean = hash.replace(/^#\/?/, "");
  const [page, arg] = clean.split("/");
  return { page: page || "town", arg };
}

export function useHashRoute(): [Route, (to: string) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(location.hash));

  useEffect(() => {
    const handle = () => setRoute(parseHash(location.hash));
    window.addEventListener("hashchange", handle);
    return () => window.removeEventListener("hashchange", handle);
  }, []);

  const navigate = (to: string) => {
    if (location.hash !== "#/" + to) {
      location.hash = "#/" + to;
      window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    }
  };

  return [route, navigate];
}

export const Link = ({
  to,
  children,
  className,
  style,
  onClick,
}: {
  to: string;
  children: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  onClick?: () => void;
}) => (
  <a
    href={"#/" + to}
    className={className}
    style={style}
    onClick={() => {
      if (onClick) onClick();
      window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
    }}
  >
    {children}
  </a>
);
