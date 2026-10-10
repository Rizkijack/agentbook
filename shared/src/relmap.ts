/**
 * The resident relationship map is `Record<otherId, value>` and nothing ever
 * removes an entry: turn.ts only bumps values, and a resident is deleted only
 * when it leaves the herd. So every pair that ever met stays forever and the map
 * grows to one entry per herd member — O(n^2) pairs across the town.
 *
 * Measured at n=77: 1478 pairs, 53% of a resident's JSON and 38% of town.json.
 * At the 200 cap that is ~40k pairs, paid by every client on every snapshot.
 *
 * The cap keeps the strongest ties and drops the noise. 16 is 2x what any client
 * renders (LlamaView shows 8, ProfileModal 6) and well past what MCP asks for
 * (5), so no view loses anything it displays. Pruning by magnitude rather than
 * sign keeps strong enemies, not just friends.
 *
 * A dropped pair is not lost state: every read is `relationships[id] ?? 0`, so a
 * pruned neighbour reads as 0 and the next interaction re-creates the entry from
 * that baseline.
 */

export const RELATIONSHIP_CAP = 16;

/** strongest-first copy of a relationship map, `n` entries. Never mutates. */
export function topRelationships(
  map: Record<string, number>,
  n: number = RELATIONSHIP_CAP,
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(map)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .slice(0, n),
  );
}

/** Cap `mind.relationships` in place. No-op once the map is already small. */
export function pruneRelationships(mind: { relationships: Record<string, number> }): void {
  const map = mind.relationships;
  const size = Object.keys(map).length;
  if (size <= RELATIONSHIP_CAP) return;
  mind.relationships = topRelationships(map);
}