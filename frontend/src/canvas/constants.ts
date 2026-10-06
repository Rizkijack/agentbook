/**
 * World grid dimensions for the browser bundle.
 *
 * These were a second, hand-kept copy of backend/src/map.ts. That is a trap:
 * growing the map updated one file and not the other, so the collision map kept
 * indexing a 210x128 world while the tiles it built were 1050x640 — every
 * square spot read as unwalkable and every path request resolved to the wrong
 * tile. The duplication was the bug.
 *
 * The numbers now live in shared/src/map.ts, which the backend also imports, so
 * the two cannot drift. backend/test/world.test.ts asserts that agreement.
 */
import { Pe, vt, V, WorldSize } from "@slopagentbook/shared";

// re-exported so existing importers keep their one-stop import path
export { Pe, vt, V, WorldSize };

export const WorldWidth = Pe * V;
export const WorldHeight = vt * V;