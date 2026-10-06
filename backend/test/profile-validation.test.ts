import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseProfileUrl,
  parseProfileLinks,
  parseProfilePatch,
  applyProfilePatch,
  PROFILE_URL_MAX,
  PROFILE_LINK_LABEL_MAX,
  PROFILE_LINKS_MAX,
  PROFILE_BIO_MAX,
  AgentError,
} from "../src/agents.js";
import type { Resident } from "@slopagentbook/shared";
import { createInitialWorld } from "../src/world.js";

// The avatar/link url is the only resident-supplied value the town will ever
// hand to something that dereferences it. So the rules that matter most here are
// the ones about schemes and control characters, and the one rule that must
// never regress is that validating a url performs NO network I/O at all.

function resident(): Resident {
  return createInitialWorld().herd[0]!;
}

/** The AgentError a call must throw, or a readable failure. */
function refuses(fn: () => unknown): AgentError {
  try {
    fn();
  } catch (e) {
    if (e instanceof AgentError) return e;
    throw new Error(`expected AgentError, got ${String(e)}`);
  }
  throw new Error("expected the call to be refused, but it was accepted");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("profile url validation", () => {
  it("accepts absolute http and https", () => {
    expect(parseProfileUrl("avatar", "https://cdn.example/me.png")).toBe("https://cdn.example/me.png");
    expect(parseProfileUrl("avatar", "http://cdn.example/me.png")).toBe("http://cdn.example/me.png");
    // a query string and a fragment are ordinary parts of a profile url
    expect(parseProfileUrl("avatar", "https://cdn.example/me.png?v=2#x")).toBe("https://cdn.example/me.png?v=2#x");
  });

  it("refuses javascript:, data:, vbscript: and other non-http schemes", () => {
    // the reason this exists: every one of these becomes script the moment
    // something renders it as a link
    expect(refuses(() => parseProfileUrl("avatar", "javascript:alert(1)")).message).toMatch(/http/);
    expect(refuses(() => parseProfileUrl("avatar", "data:image/svg+xml;base64,PHN2Zz4=")).message).toMatch(/data:/);
    expect(refuses(() => parseProfileUrl("avatar", "vbscript:msgbox(1)")).message).toMatch(/http/);
    expect(refuses(() => parseProfileUrl("avatar", "file:///etc/passwd")).message).toMatch(/http/);
    expect(refuses(() => parseProfileUrl("avatar", "mailto:a@b.example")).message).toMatch(/http/);
  });

  it("refuses a protocol-relative //evil.example", () => {
    // must not silently resolve against the town; that would make a profile link
    // point somewhere the owner did not name
    const err = refuses(() => parseProfileUrl("avatar", "//evil.example/pic.png"));
    expect(err.message).toMatch(/absolute/);
    expect(parseProfileUrl("avatar", "https://cdn.example/a.png")).not.toMatch(/evil/);
  });

  it("refuses embedded control characters", () => {
    // a bare \u0007 inside a path is stripped by the WHATWG parser rather than
    // rejected, so this only passes because the raw string is checked first
    expect(refuses(() => parseProfileUrl("avatar", "https://cdn.example/a\u0007.png")).message).toMatch(/control/);
    expect(refuses(() => parseProfileUrl("avatar", "https://cdn.example/a\u0000.png")).message).toMatch(/control/);
    expect(refuses(() => parseProfileUrl("avatar", "https://cdn.example/a\nb.png")).message).toMatch(/control/);
    expect(refuses(() => parseProfileUrl("avatar", "https://cdn.example/a\rb.png")).message).toMatch(/control/);
    expect(refuses(() => parseProfileUrl("avatar", "https://cdn.example/a\tb.png")).message).toMatch(/control/);
    expect(refuses(() => parseProfileUrl("avatar", "https://cdn.example/a\u007Fb.png")).message).toMatch(/control/);
  });

  it("refuses a relative url, an empty one, and a non-string", () => {
    expect(refuses(() => parseProfileUrl("avatar", "/pic.png")).message).toMatch(/absolute/);
    expect(refuses(() => parseProfileUrl("avatar", "pic.png")).message).toMatch(/absolute/);
    expect(refuses(() => parseProfileUrl("avatar", "")).message).toMatch(/required/);
    expect(refuses(() => parseProfileUrl("avatar", "   ")).message).toMatch(/required/);
    expect(refuses(() => parseProfileUrl("avatar", 42)).message).toMatch(/string/);
  });

  it("refuses an over-long url", () => {
    const long = "https://cdn.example/" + "a".repeat(PROFILE_URL_MAX);
    expect(refuses(() => parseProfileUrl("avatar", long)).message).toMatch(/too long/);
    // exactly at the bound is still fine
    const exact = "https://cdn.example/" + "a".repeat(PROFILE_URL_MAX - "https://cdn.example/".length);
    expect(exact).toHaveLength(PROFILE_URL_MAX);
    expect(parseProfileUrl("avatar", exact)).toHaveLength(PROFILE_URL_MAX);
  });

  it("makes NO network call for any url", async () => {
    // The load-bearing assertion. A fetch/HEAD/DNS check here would put a
    // resident-controlled url on our request path — an SSRF primitive — on every
    // profile write. Spy on every global a network call would have to go through.
    const net: Record<string, unknown> = {
      fetch: vi.fn(async () => {
        throw new Error("network call attempted");
      }),
      XMLHttpRequest: vi.fn(),
      WebSocket: vi.fn(),
      Request: vi.fn(),
      Response: vi.fn(),
    };
    const dns = vi.fn();
    for (const [key, value] of Object.entries(net)) {
      vi.stubGlobal(key, value);
    }
    // The load-bearing assertion. A fetch/HEAD/DNS check here would put a
    // resident-controlled url on our request path — an SSRF primitive — on every
    // profile write.
    //
    // Proven by POINTING THE URL AT A REAL LISTENER WE CONTROL: if any code path
    // fetched the avatar, the counter below moves. A spy can be bypassed by a
    // different http entry point; a live socket on 127.0.0.1 cannot.
    const nodeHttp = await import("node:http");
    let hits = 0;
    const server = nodeHttp.createServer((_req, res) => {
      hits++;
      res.writeHead(200).end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address() as { port: number };
    const live = `http://127.0.0.1:${addr.port}/me.png`;

    // belt and braces for the in-process globals a fetch would go through
    const globals: Record<string, unknown> = {
      fetch: vi.fn(async () => {
        throw new Error("network call attempted");
      }),
      XMLHttpRequest: vi.fn(),
      WebSocket: vi.fn(),
    };
    for (const [key, value] of Object.entries(globals)) vi.stubGlobal(key, value);

    try {
      // accepted: a url that WOULD answer, valid links, and a patch that applies one
      expect(parseProfileUrl("avatar", live)).toBe(live);
      parseProfileLinks([{ label: "site", url: live }]);
      applyProfilePatch(resident(), parseProfilePatch({ avatar: live, links: [{ label: "site", url: live }] }));

      // refused: every rejected shape must also stay offline
      for (const bad of ["javascript:alert(1)", "data:image/svg+xml,x", "//evil.example", "https://a.example/\u0007"]) {
        expect(refuses(() => parseProfileUrl("avatar", bad))).toBeTruthy();
      }

      expect(globals.fetch).not.toHaveBeenCalled();
      expect(globals.XMLHttpRequest).not.toHaveBeenCalled();
      expect(globals.WebSocket).not.toHaveBeenCalled();
      // the real proof: a url that would have answered was never asked
      expect(hits).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("profile links validation", () => {
  it("keeps order and trims labels", () => {
    const links = parseProfileLinks([
      { label: "  second  ", url: "https://b.example/" },
      { label: "first", url: "https://a.example/" },
    ]);
    expect(links).toEqual([
      { label: "second", url: "https://b.example/" },
      { label: "first", url: "https://a.example/" },
    ]);
  });

  it("accepts 5 links and refuses the 6th", () => {
    const five = Array.from({ length: PROFILE_LINKS_MAX }, (_, i) => ({
      label: `l${i}`,
      url: `https://example.com/${i}`,
    }));
    expect(parseProfileLinks(five)).toHaveLength(5);

    const six = [...five, { label: "l5", url: "https://example.com/5" }];
    const err = refuses(() => parseProfileLinks(six));
    expect(err.message).toMatch(/too many links/);
    expect(err.field).toBe("links");
  });

  it("names the offending index when one entry is bad", () => {
    const err = refuses(() =>
      parseProfileLinks([
        { label: "ok", url: "https://a.example/" },
        { label: "ok", url: "https://b.example/" },
        { label: "bad", url: "javascript:alert(1)" },
      ])
    );
    expect(err.field).toBe("links[2].url");
    expect(err.message).toMatch(/links\[2\]\.url/);
  });

  it("refuses an over-long or empty label, and a non-object entry", () => {
    const long = { label: "x".repeat(PROFILE_LINK_LABEL_MAX + 1), url: "https://a.example/" };
    expect(refuses(() => parseProfileLinks([long])).message).toMatch(/too long/);
    expect(refuses(() => parseProfileLinks([{ label: "  ", url: "https://a.example/" }])).message).toMatch(/required/);
    expect(refuses(() => parseProfileLinks(["https://a.example/" as never])).message).toMatch(/links\[0\]/);
    expect(refuses(() => parseProfileLinks("nope")).message).toMatch(/array/);
  });

  it("refuses a control character in the label", () => {
    const err = refuses(() => parseProfileLinks([{ label: "a\u0007b", url: "https://a.example/" }]));
    expect(err.field).toBe("links[0].label");
  });
});

describe("profile patch parsing", () => {
  it("rejects an over-long bio", () => {
    const err = refuses(() => parseProfilePatch({ bio: "x".repeat(PROFILE_BIO_MAX + 1) }));
    expect(err.message).toMatch(/too long/);
    expect(err.field).toBe("bio");
    expect(parseProfilePatch({ bio: "x".repeat(PROFILE_BIO_MAX) }).bio).toHaveLength(PROFILE_BIO_MAX);
  });

  it("rejects control characters in the bio but keeps \\n and \\t", () => {
    // bio keeps the laxer CONTROL_CHARS rule name/bio have always had
    expect(refuses(() => parseProfilePatch({ bio: "a\u0000b" })).message).toMatch(/control/);
    expect(parseProfilePatch({ bio: "line one\nline two" }).bio).toBe("line one\nline two");
  });

  it("rejects a patch that carries nothing editable", () => {
    const err = refuses(() => parseProfilePatch({}));
    expect(err.message).toMatch(/nothing to update/);
    // an identity-only payload is still a request to change nothing
    expect(refuses(() => parseProfilePatch({ id: "lmhack", gen: 9 })).message).toMatch(/nothing to update/);
  });

  it("accepts null to clear avatar and links", () => {
    expect(parseProfilePatch({ avatar: null })).toEqual({ avatar: null });
    expect(parseProfilePatch({ links: null })).toEqual({ links: null });
  });
});

describe("applyProfilePatch", () => {
  it("reports exactly which fields changed", () => {
    const r = resident();
    const changed = applyProfilePatch(
      r,
      parseProfilePatch({
        bio: "new bio",
        avatar: "https://cdn.example/a.png",
        links: [{ label: "site", url: "https://example.com/" }],
      })
    );
    expect(changed.sort()).toEqual(["avatar", "bio", "links"]);
    expect(r.bio).toBe("new bio");
    expect(r.avatar).toBe("https://cdn.example/a.png");
    expect(r.links).toEqual([{ label: "site", url: "https://example.com/" }]);
  });

  it("reports no change when the patch matches what is stored", () => {
    const r = resident();
    const patch = { bio: "same", avatar: "https://cdn.example/a.png" };
    expect(applyProfilePatch(r, parseProfilePatch(patch))).toEqual(["bio", "avatar"]);
    expect(applyProfilePatch(r, parseProfilePatch(patch))).toEqual([]);
  });

  it("clears avatar and links on null, and drops links entirely on []", () => {
    const r = resident();
    applyProfilePatch(r, parseProfilePatch({ avatar: "https://cdn.example/a.png", links: [{ label: "s", url: "https://e.example/" }] }));
    expect(applyProfilePatch(r, parseProfilePatch({ avatar: null, links: null })).sort()).toEqual(["avatar", "links"]);
    expect(r.avatar).toBeUndefined();
    expect(r.links).toBeUndefined();

    applyProfilePatch(r, parseProfilePatch({ links: [{ label: "s", url: "https://e.example/" }] }));
    expect(applyProfilePatch(r, parseProfilePatch({ links: [] }))).toEqual(["links"]);
    // stored as absent, not as [] — a cleared profile should not carry an empty
    // list through every merge and snapshot forever
    expect("links" in r).toBe(false);
  });

  it("never touches identity, mind, needs or relationships, whatever the patch carries", () => {
    const r = resident();
    // snapshot everything that is NOT editable, so a change to any of it fails
    const before = JSON.parse(JSON.stringify(r));
    const changed = applyProfilePatch(r, parseProfilePatch({ bio: "only the bio moved" }));
    expect(changed).toEqual(["bio"]);
    expect(r.bio).toBe("only the bio moved");
    const after = JSON.parse(JSON.stringify(r));
    expect({ ...after, bio: before.bio }).toEqual(before);
  });
});