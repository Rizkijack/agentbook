import { describe, it, expect } from "vitest";
import {
  buildGraph,
  nextExit,
  rightNormal,
  pointOnSpan,
  LANE_OFFSET,
  type RoadGraph,
} from "../src/canvas/roadgraph.js";
import { ROADS } from "@slopagentbook/shared";

// Runtime traffic routing. The property that matters is that a vehicle cannot
// end up somewhere a road is not: the old per-road loops guaranteed it by
// construction, and a graph has to earn the same guarantee. A unit that picks a
// bad exit, or that reverses at a junction, will drive on grass — so the lane
// offset and the dead-end rule are both load-bearing, not cosmetic.

const g = (): RoadGraph =>
  buildGraph(ROADS.map((r) => ({ x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 })));

/** A deterministic [0,1) source, so a failure is reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

describe("road graph", () => {
  it("merges collinear pieces into shared junctions, and leaves no node stranded", () => {
    const graph = g();
    // Fewer nodes than road segments is the correct shape: the emitter splits
    // long roads into consecutive pieces, and two pieces that continue each
    // other are one junction, not two. Requiring a node per segment was the
    // expectation before the geometry was measured, and it is wrong.
    expect(graph.nodes.length).toBeLessThan(ROADS.length);
    for (let i = 0; i < graph.nodes.length; i++) {
      expect(graph.edges[i], `node ${i} has no exits - nothing could arrive or leave`).toBeDefined();
      expect(graph.edges[i]!.length).toBeGreaterThan(0);
    }
    // A grid town must actually have crossroads, or there is nowhere to turn.
    const crossings = graph.edges.filter((l) => l.length >= 3).length;
    expect(crossings, "expected real junctions, not a set of dead ends").toBeGreaterThan(20);
  });

  it("gives every span a real length and a unit direction", () => {
    const graph = g();
    for (const list of graph.edges) {
      for (const s of list) {
        expect(s.len).toBeGreaterThan(0);
        expect(Math.abs(s.dx) > 0 || Math.abs(s.dy) > 0).toBe(true);
      }
    }
  });

  it("pairs each span with a reciprocal, so a road carries both directions", () => {
    const graph = g();
    const spans = graph.edges.flat();
    const key = (s: { from: number; to: number }) => `${s.from}>${s.to}`;
    const set = new Set(spans.map(key));
    let paired = 0;
    for (const s of spans) if (set.has(`${s.to}>${s.from}`)) paired++;
    expect(paired, "every span must have a way back").toBe(spans.length);
  });
});

describe("nextExit", () => {
  it("avoids reversing when there is a choice, so traffic does not ping-pong", () => {
    const graph: RoadGraph = {
      nodes: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      edges: [
        [
          { from: 0, to: 1, len: 10, horizontal: true, dx: 10, dy: 0 },
          { from: 0, to: 2, len: 10, horizontal: true, dx: 10, dy: 0 },
        ],
        [{ from: 1, to: 0, len: 10, horizontal: true, dx: -10, dy: 0 }],
        [
          { from: 2, to: 0, len: 10, horizontal: false, dx: 0, dy: -10 },
          { from: 2, to: 1, len: 10, horizontal: false, dx: 0, dy: 10 },
        ],
      ],
    };
    // arriving at 2 from 0, the only onward move is to 1 - never back to 0
    for (let i = 0; i < 40; i++) {
      const s = nextExit(graph, 2, 0, lcg(i));
      expect(s!.to).toBe(1);
    }
  });

  it("reverses at a dead end, because that is the only legal move", () => {
    // Refusing to reverse would strand a unit on a spur for the life of the page.
    const graph: RoadGraph = {
      nodes: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      edges: [
        [{ from: 0, to: 1, len: 10, horizontal: true, dx: 10, dy: 0 }],
        [{ from: 1, to: 0, len: 10, horizontal: true, dx: -10, dy: 0 }],
      ],
    };
    const s = nextExit(graph, 1, 0, () => 0.5);
    expect(s).not.toBeNull();
    expect(s!.to).toBe(0);
  });

  it("returns null at a node with no exits rather than throwing", () => {
    const graph: RoadGraph = { nodes: [{ x: 0, y: 0 }], edges: [[]] };
    expect(nextExit(graph, 0, -1, () => 0.5)).toBeNull();
  });

  it("actually varies the choice, so traffic spreads instead of one fixed loop", () => {
    const graph = g();
    const junction = graph.nodes.findIndex((_, i) => graph.edges[i]!.length >= 4);
    expect(junction, "expected at least one real 4-way junction in the network").toBeGreaterThanOrEqual(0);
    const picks = new Set<number>();
    for (let i = 0; i < 60; i++) {
      const s = nextExit(graph, junction, -1, lcg(i * 7919));
      if (s) picks.add(s.to);
    }
    expect(picks.size, "a 4-way junction always chose the same exit").toBeGreaterThan(1);
  });
});

describe("right-hand lane", () => {
  it("puts the right-hand side on the correct side for every direction", () => {
    // Travelling east, right is south (screen +y). Travelling north, right is east.
    // +y is DOWN in tile space, so a negative dy is a northward unit and its
    // right hand points east (+x). Getting this backwards puts every vehicle in
    // the oncoming lane, which is invisible in a test that shares the mistake.
    expect(rightNormal(1, 0)).toEqual({ nx: 0, ny: 1 }); // east  -> right is south
    expect(rightNormal(-1, 0)).toEqual({ nx: 0, ny: -1 }); // west  -> right is north
    expect(rightNormal(0, -1)).toEqual({ nx: 1, ny: 0 }); // north -> right is east
    expect(rightNormal(0, 1)).toEqual({ nx: -1, ny: 0 }); // south -> right is west
  });

  it("stays inside a 2-tile carriageway, whichever way the unit faces", () => {
    // The whole reason the offset is from the centreline: both directions must
    // remain on tarmac, and a 2-tile road gives 0.3 of a tile either side.
    expect(LANE_OFFSET, "0.3 tiles = 4.8px puts a vehicle outside the 5px kerb inset").toBeLessThanOrEqual(0.2);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const { nx, ny } = rightNormal(dx!, dy!);
      expect(Math.abs(nx) + Math.abs(ny)).toBe(1);
      expect(LANE_OFFSET).toBeLessThan(0.2);
    }
  });

  it("clamps to the span, so a unit cannot be drawn past the end of its road", () => {
    const span = { from: 0, to: 1, len: 10, horizontal: true, dx: 10, dy: 0 };
    const start = pointOnSpan(span, 999, 0, 0);
    expect(start.x).toBeLessThanOrEqual(10 + LANE_OFFSET);
    const back = pointOnSpan(span, -999, 0, 0);
    expect(back.x).toBeGreaterThanOrEqual(-LANE_OFFSET);
  });
});

describe("a driven unit stays on the network", () => {
  it("never leaves the carriageway, over a long run with many junctions", () => {
    // The property the old loops had for free. A graph has to be driven to prove
    // it: every position is checked against every road, exactly as the existing
    // lane test does for the current fleet.
    const graph = g();
    const onRoad = (x: number, y: number) =>
      ROADS.some((r) => {
        const left = r.x1 * 16 + 5,
          right = (r.x2 + 1) * 16 - 5,
          top = r.y1 * 16 + 5,
          bottom = (r.y2 + 1) * 16 - 5;
        return x >= left && x <= right && y >= top && y <= bottom;
      });

    // Start each run on a real span so we begin on tarmac, not at an arbitrary node.
    const starts = graph.edges.flatMap((l) => l);
    for (let seed = 0; seed < 12; seed++) {
      const rng = lcg(seed * 104729 + 17);
      let span = starts[Math.floor(rng() * starts.length)]!;
      let from = span.from;
      let d = rng() * span.len;
      for (let step = 0; step < 400; step++) {
        const n = graph.nodes[from]!;
        const p = pointOnSpan(span, d, n.x, n.y);
        expect(
          onRoad(p.x * 16, p.y * 16),
          `seed ${seed} step ${step}: unit at tile ${p.x.toFixed(2)},${p.y.toFixed(2)} is off road`,
        ).toBe(true);
        const next = nextExit(graph, span.to, from, rng);
        if (!next) break;
        span = next;
        from = span.from;
        d = rng() * span.len * 0.2; // most of the time, not the far end
      }
    }
  });
});