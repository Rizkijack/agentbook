import { describe, it, expect } from "vitest";
import { mergeSnapshots, normalizeHerd } from "../src/pgstore.js";
import { createInitialWorld } from "../src/world.js";
import type { Resident, TownSnapshot } from "@slopagentbook/shared";

// `avatar`/`links` are two more optional keys on Resident, and the town is one
// JSONB row written by N instances that each hold their own in-memory copy. That
// is the exact shape that has bitten this repo before: a field that works on the
// happy path and then gets dropped by the merge, because the merge treats a
// resident as an opaque row rather than a set of known columns.
//
// These tests pin the round trip rather than the assumption. The merge is
// append-mostly and keyed by id (pgstore.ts header), so a whole resident object
// ought to ride along with nothing to change — "ought to" is exactly what the
// tombstone regression looked like.

const AVATAR = "https://cdn.example/vetch.png";
const LINKS = [
  { label: "site", url: "https://example.com/vetch" },
  { label: "feed", url: "https://example.com/vetch/feed" },
];

/**
 * A snapshot whose first resident carries avatar + links.
 *
 * Built by deep-cloning a single world rather than calling createInitialWorld()
 * twice: resident ids come from Math.random(), so two calls produce two towns
 * with the same names but different ids — and `dedupeHerdByName` would then
 * discard half of each. A stale instance is a copy of ONE town, so that is what
 * this has to be for the merge to be modelling the real thing.
 */
function worldWithProfile(): TownSnapshot {
  const world = clone(createInitialWorld());
  world.herd[0]!.avatar = AVATAR;
  world.herd[0]!.links = LINKS.map((l) => ({ ...l }));
  return world;
}

/** A stale instance's copy: same town, booted before the profile was ever set. */
function staleCopyOf(world: TownSnapshot): TownSnapshot {
  const stale = clone(world);
  for (const r of stale.herd) {
    delete r.avatar;
    delete r.links;
  }
  return stale;
}

/** Deep clone through JSON — the same trip the JSONB row takes. */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** The resident under test, found by the id the assertions name. */
function vetchOf(world: { herd: Resident[] }, id: string): Resident {
  const found = world.herd.find((h) => h.id === id);
  expect(found, `resident ${id} is missing from the merged herd`).toBeTruthy();
  return found!;
}

describe("merge round trip: avatar/links", () => {
  it("survives a merge against another instance's stale copy", () => {
    const mine = worldWithProfile();
    const id = mine.herd[0]!.id;
    // booted before the profile was set: same town, no avatar, no links
    const stale = staleCopyOf(mine);

    const merged = mergeSnapshots(stale, mine) as { herd: Resident[] };
    const vetch = vetchOf(merged, id);
    expect(vetch.avatar).toBe(AVATAR);
    expect(vetch.links).toEqual(LINKS);
  });

  it("drops the profile when a STALE instance is the one saving", () => {
    // The mirror image, and the honest cost of the merge's rule: ours wins on a
    // shared id, so an instance that booted before the edit can save next and
    // write its older copy over the newer one — avatar and links included.
    // Recorded here rather than papered over, because it is a real property of
    // `unionBy`, not a bug in this change: it applies to every field on a
    // resident, bio included. One tick later the instance that made the edit
    // saves and the town converges. Deliberately NOT "fixed" by special-casing
    // two keys in the merge — that would be the first place the append-mostly
    // rule stops being uniform.
    const mine = worldWithProfile();
    const id = mine.herd[0]!.id;
    const stale = staleCopyOf(mine);

    const merged = mergeSnapshots(mine, stale) as { herd: Resident[] };
    const vetch = vetchOf(merged, id);
    expect(vetch.avatar).toBeUndefined();
    expect(vetch.links).toBeUndefined();
  });

  it("survives a save/merge round trip with a resident the stale copy has never seen", () => {
    // the resurrection case: a brand-new resident carrying a profile must not be
    // the thing a merge discards
    const mine = worldWithProfile();
    const newcomer: Resident = { ...mine.herd[1]!, id: "lmnewcomer", name: "Newcomer" };
    newcomer.avatar = "https://cdn.example/new.png";
    newcomer.links = [{ label: "home", url: "https://example.com/new" }];
    mine.herd.push(newcomer);

    const stale = staleCopyOf(mine);
    stale.herd = stale.herd.filter((h) => h.id !== "lmnewcomer");

    const merged = mergeSnapshots(stale, mine) as { herd: Resident[] };
    const found = vetchOf(merged, "lmnewcomer");
    expect(found.avatar).toBe("https://cdn.example/new.png");
    expect(found.links).toEqual([{ label: "home", url: "https://example.com/new" }]);
  });

  it("survives JSON serialisation, which is how the row is actually stored", () => {
    // the row is JSONB: an in-memory field that did not serialise would look
    // perfect until the next boot
    const mine = worldWithProfile();
    const id = mine.herd[0]!.id;
    const stored = clone(mine);
    const merged = JSON.parse(JSON.stringify(mergeSnapshots(stored, mine))) as TownSnapshot;
    const vetch = vetchOf(merged, id);
    expect(vetch.avatar).toBe(AVATAR);
    expect(vetch.links).toHaveLength(2);
  });

  it("is untouched by normalizeHerd, which boot runs on its own", () => {
    const world = worldWithProfile();
    const id = world.herd[0]!.id;
    // normalizeHerd is typed on unknown input and answers opaque rows
    const normalized = normalizeHerd(world) as unknown as Resident[];
    const vetch = vetchOf({ herd: normalized }, id);
    expect(vetch.avatar).toBe(AVATAR);
    expect(vetch.links).toHaveLength(2);
  });

  it("an old snapshot with neither field still loads and still typechecks", () => {
    // the compatibility requirement: both fields are optional precisely so a
    // snapshot written before they existed is still a valid TownSnapshot. If a
    // future edit makes either required, this stops compiling — which is the
    // point of annotating it as TownSnapshot rather than `as any`.
    const withProfile = worldWithProfile();
    // a save from before avatar/links existed: the SAME town (same ids, so the
    // merge actually has to reconcile the two copies), with neither field
    const old = staleCopyOf(withProfile);

    for (const resident of old.herd) {
      expect(resident.avatar).toBeUndefined();
      expect(resident.links).toBeUndefined();
      // ...and the optional fields are writable without a cast
      resident.avatar = "https://cdn.example/new.png";
      resident.links = [{ label: "a", url: "https://b.example/" }];
      delete resident.avatar;
      delete resident.links;
    }

    // and it still merges against a snapshot that has them
    const merged = mergeSnapshots(old, withProfile) as { herd: Resident[] };
    const vetch = vetchOf(merged, withProfile.herd[0]!.id);
    expect(vetch.avatar).toBe(AVATAR);
    expect(vetch.links).toEqual(LINKS);
  });
});