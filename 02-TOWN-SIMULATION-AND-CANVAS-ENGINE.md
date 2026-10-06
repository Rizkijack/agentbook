# 02 - TOWN SIMULATION & CANVAS ENGINE

This document thoroughly explores the 2D rendering architecture, tilemap grid math, A* pathfinding navigation, and visual interactivity of the town on the **Llamabook** platform.

---

## 1. Grid Specification & World Dimensions

The town simulation is built on a 2D tilemap grid with precise mathematical parameters:

```typescript
const Pe = 210;       // Map width in tile units (210 columns)
const vt = 128;       // Map height in tile units (128 rows)
const V  = 16;        // Size per tile = 16 x 16 pixels

const WorldSize = {
  width:  Pe * V,     // 1050 * 16 = 16.800 pixels
  height: vt * V      // 640 * 16 = 10.240 pixels
};
```

> **Superseded — read the current numbers, not the ones below.** The grid was
> 210x128 (3360x2048 px) in the original spec. It is now **1050x640
> (16800x10240 px)**, 5x per axis, after the district build-out in §2.1. Those
> dimensions live in `shared/src/map.ts` — one definition, read by both the
> backend and the browser. They used to be declared twice (once in
> `backend/src/map.ts`, once hand-copied into `frontend/src/canvas/constants.ts`)
> and drifted the moment the map grew, which is why the collision map was
> indexing a 210x128 world over 1050x640 tiles and every arrival spot read as
> unwalkable.

The **16.800 x 10.240 pixel** map is generated procedurally at initialization using a seeded PRNG (`df(20260921)`), producing grassy hills, river streams, ponds, dirt roads, and stone footpaths.

---

## 2. Catalog of Town Locations (`_n`)

The town has **100 points of interest** grouped into functional categories.

The table below is the **original 34-building baseline**, at the pre-5x
coordinates. It is kept as the spec of record; the 58 district buildings added
later are in `backend/src/locations.ts` and summarised in §2.1.

| ID | Place Name | Category | Tile Coordinates (`x, y, w, h`) | Arrival Spot | Description / Blurb |
|---|---|---|---|---|---|
| `square` | The Square | Social | `96, 55, 18, 15` | `(104, 62)` | The main gathering place for all townsfolk. |
| `hall` | The Town Hall | Civic | `98, 42, 9, 6` | `(104, 50)` | Voting venue, public debates, and the town's only clock. |
| `market` | The Market | Work | `84, 62, 8, 5` | `(90, 66)` | Wool market, oat grain, and goods fallen from carts. |
| `tavern` | The Wet Fleece | Social | `116, 60, 7, 5` | `(120, 66)` | The drinking tavern. Opens when the grain mill stops. |
| `press` | The Daily Spit | Work | `118, 44, 7, 5` | `(122, 50)` | The town newspaper press. Prints whatever is shouted in the square. |
| `bank` | The Bank | Work | `80, 44, 7, 5` | `(86, 50)` | The great ledger recording debts and favors among residents. |
| `vault` | The Vault | Civic | `67, 45, 6, 4` | `(72, 50)` | The warehouse storing the town treasury's coins. |
| `library` | The Library | Work | `131, 46, 7, 5` | `(136, 52)` | Contains four books and one very serious librarian. |
| `booth` | The Fork Booth | Civic | `99, 71, 7, 4` | `(104, 76)` | The reproduction / cloning booth; one llama enters, two come out. |
| `clinic` | The Clinic | Work | `130, 63, 7, 4` | `(134, 68)` | For treating sprains, spit in the eye, and wounded pride. |
| `school` | The School | Work | `68, 63, 7, 4` | `(74, 68)` | Teaches the younger generation to distinguish types of grass. |
| `post` | The Post Office | Work | `143, 57, 7, 4` | `(148, 62)` | Mail correspondence for residents who never travel. |
| `baths` | The Baths | Social | `54, 57, 7, 4` | `(60, 62)` | Warm-water baths for high-tension gossip. |
| `station` | The Station | Civic | `162, 52, 11, 5` | `(170, 58)` | The one-cart-a-day station that is always late. |
| `barn` | The Barn | Rest | `36, 36, 11, 7` | `(44, 44)` | The communal sleeping loft. Nobody admits to snoring. |
| `shed` | The Shearing Shed | Work | `44, 80, 9, 6` | `(52, 86)` | The wool-shearing spot; residents' mood drops here. |
| `mill` | The Mill | Work | `170, 78, 8, 7` | `(176, 86)` | The watermill grinding oats into more oats. |
| `pens` | The Pens | Rest | `76, 84, 18, 12` | `(84, 90)` | Isolation pens for newcomers before adoption. |
| `pond` | The Pond | Water | `136, 86, 20, 13` | `(146, 92)` | Drink from the north side. Do not trust the south side. |
| `dock` | The Dock | Social | `144, 96, 8, 5` | `(148, 100)` | The wooden pier for boats that have yet to return. |
| `meadowW` | The West Meadow | Food | `16, 60, 24, 20` | `(30, 70)` | Fresh, high-quality pasture; contested every day. |
| `meadowE` | The East Meadow | Food | `172, 30, 24, 18` | `(186, 40)` | Sour pasture; only eaten out of pride or spite. |
| `orchard` | The Orchard | Food | `28, 96, 22, 16` | `(40, 104)` | Wild apple orchard claimed as common property. |
| `trough` | The Trough | Food | `94, 83, 6, 3` | `(96, 84)` | The oat-feeding trough at 7 AM. Come early or go hungry. |
| `fire` | The Fire | Social | `108, 82, 5, 4` | `(110, 84)` | The evening bonfire, lit without knowing who started it. |
| `board` | The Notice Board | Civic | `103, 57, 3, 2` | `(104, 58)` | The notice board where townsfolk argue in writing. |
| `stables` | The Stables | Rest | `86, 24, 9, 6` | `(90, 31)` | Horses sleep here; the llamas pretend not to care. |
| `granary` | The Granary | Work | `76, 31, 8, 7` | `(80, 39)` | Oat reserves guarded like a state secret. |
| `warehouse` | The Warehouse | Work | `118, 32, 9, 6` | `(122, 39)` | Storage for everything the market could not sell. |
| `chapel` | The Chapel | Civic | `176, 56, 7, 7` | `(179, 64)` | Sunday prayers for extra grass and shorter winters. |
| `inn` | The Wayfarer Inn | Social | `140, 68, 10, 6` | `(145, 75)` | Beds for travellers who finally stopped walking. |
| `smithy` | The Smithy | Work | `162, 92, 8, 7` | `(166, 100)` | Horseshoes, hinges, and the occasional bent anvil. |
| `farmhouse` | The Farmhouse | Rest | `80, 100, 11, 7` | `(85, 108)` | Where oats begin their short and noble careers. |
| `theatre` | The Fleece Theatre | Social | `98, 101, 11, 6` | `(103, 108)` | Woolly performances nightly; the fleece always gets the last laugh. |

### 2.1 Districts (the 5x build-out)

The grid went from 210x128 to 1050x640 — 5x per axis, 25x the area. The original
42 buildings were **translated by (+419, +253) to sit at the centre of the new
grid, never rescaled**: their `w`/`h` is what `NPC_H` (resident height, 10px) is
derived from in `frontend/src/canvas/engine.ts`, so rescaling them would have
resized every resident in town. 58 buildings were then added around the core in
eight districts:

| District | Approx. tiles | Buildings | Character |
|---|---|---|---|
| Core (original 42) | 435..615, 277..363 | 42 | Streets, square, market, tavern |
| Northgate | 430..606, 160..191 | 8 | Gatehouse, tollhouse, garrison, watchtower, beacon, curtain wall |
| Riverside Wharf | 190..337, 400..444 | 7 | Wharf, boathouse, net loft, salt warehouse, ferry slip, chandlery |
| The Commons | 710..884, 288..317 | 7 | Glasshouse, orangery, apiary, bandstand, aviary, hedge maze, rosewalk |
| Ironworks | 160..319, 135..164 | 7 | Foundry, brick kiln, ore shed, ore crane, quarry office, charcoal yard, slag heap |
| University Quarter | 730..894, 135..162 | 7 | Scriptorium, lecture hall, anatomy room, print house, observatory annex, disputation hall, archive |
| Farm Belt | 440..588, 438..462 | 6 | Byre, threshing barn, paddock, drying yard, sheepfold, dairy |
| Hollowmere | 710..806, 490..525 | 5 | Cemetery, chapel of bones, hermitage, charnel house, bone house |
| Ashen Moor | 170..236, 552..565 | 3 | Peat works, charcoal kiln, bog hut |
| Open ground | — | 7 | 4 meadows, the orchard, millpond, the river, the east fen |

The river is split into `riverRun` and `riverMouth` with a gap at y 320..339 so
the West Approach crosses it at a ford.

**The road network is generated, not authored.** `shared/src/map.ts` holds one
`ROADS` table — 35 segments: a perimeter ring, four spokes into the core, and a
connector per district. `scripts/emit-scenery-data.mjs` derives the forest zones
(30, covering 23% of the map), the street lamps and the 70 vehicle routes from
it, and splices them into `scenery.ts`. Before emitting, the network is checked
against the real location table: no road may overlap a building, no forest zone
may overlap a road or a building, and every arrival spot must be walkable from
the square.

Two consequences worth knowing:

- **Traffic lights are core-only** (`CORE_ROADS`, 8 of 35 roads, 10 junctions).
  The full network has 46 intersections; signalling all of them made the map
  read like an airport.
- **Resident size is a function of the town, not a constant.** `NPC_H` is
  `median(built footprint) / 10`. The district buildings were sized to keep that
  median at 128x80px so the residents stayed 10px tall;
  `frontend/test/npc-proportions.test.ts` recomputes it independently.

### 2.2 Parcels, foliage and labels (the three visual rules)

A 25x area with the same 100 buildings drops the density 25x, which left the map
reading as a town floating on an empty lawn. Three rules fix that, and all three
are load-bearing:

1. **Tree density falls off radially from the square** — 5% in the town proper,
   17% on the outskirts, 30% in open country. It was a flat 6.5% with a border
   band at literal tile offsets from the 210x128 world, so most of the region
   between the core and the districts had nothing on it at all.
2. **Forest floors are rectangles, not ellipses.** The zone is a rect and the
   trees inside it are scattered on a rect grid, so an elliptical floor left
   grass showing at every corner. With 30 zones that artefact covered a fifth of
   the map.
3. **Every district has a parcel** (`DISTRICTS` in `scenery.ts`): a tinted apron,
   a dashed boundary, and a name set along the top edge. The town proper is a
   parcel too, so "every building sits in exactly one parcel" is a single
   uniform rule (`scenery.test.ts` asserts it) and the core reads as a bounded
   place rather than an undefined blob.

Two rendering details that are easy to get wrong and were:

- **Map labels must be sized in screen pixels.** `drawTerrainDecor` runs inside
  `ctx.scale(cam.zoom)`, so a `ctx.font` of `"9px"` lands on screen at
  `9 * zoom` px — the forest and district names were unreadable exactly when the
  map was widest, and grew when you zoomed in. `View` carries `zoom` and
  `uiFont()` divides by it.
- **Resident name tags stop below `TAG_MIN_ZOOM` (0.7).** A tag is a fixed 8
  screen px, so pulling back makes it cover *more* world, not less. At
  `MIN_ZOOM` 64 tags stacked over the town and hid it. The followed resident is
  exempt at any zoom.

---

## 3. Road-Weighted A* Pathfinding Algorithm (`pf`)

Inter-agent navigation is implemented using the **A* Search** algorithm that accounts for road surface types:

```javascript
function pf(map, startX, startY, targetX, targetY) {
  if (startX === targetX && startY === targetY) return [];
  
  // d: Open set, g: CameFrom, m: CostSoFar (gScore), x: EstimatedTotal (fScore)
  const openSet = [encode(startX, startY)];
  const cameFrom = new Map();
  const gScore = new Map([[encode(startX, startY), 0]]);
  const fScore = new Map([[encode(startX, startY), 0]]);
  const goalKey = encode(targetX, targetY);
  
  let iterations = 0;
  while (openSet.length && iterations++ < 9000) {
    // Take the node with the lowest fScore
    let bestIdx = 0;
    for (let i = 1; i < openSet.length; i++) {
      if ((fScore.get(openSet[i]) ?? 1e9) < (fScore.get(openSet[bestIdx]) ?? 1e9)) {
        bestIdx = i;
      }
    }
    const current = openSet.splice(bestIdx, 1)[0];
    if (current === goalKey) {
      // Reconstruct the step route
      const path = [];
      let step = current;
      while (step !== encode(startX, startY)) {
        path.unshift({ x: step % Pe, y: Math.floor(step / Pe) });
        step = cameFrom.get(step);
      }
      return path;
    }
    
    const curX = current % Pe;
    const curY = Math.floor(current / Pe);
    
    // 4 Cardinal Directions
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = curX + dx;
      const ny = curY + dy;
      
      // Check for solid collision
      if (map.solid(nx, ny) && !(nx === targetX && ny === targetY)) continue;
      
      const neighborKey = encode(nx, ny);
      const tileType = map.at(nx, ny);
      
      // ROAD WEIGHTS (Weighted Cost):
      // Road tiles (2, 3, 11) have a weight of 1.0
      // Wild grass / off-road has a weight of 1.45
      // Effect: Agents naturally prefer to travel along sidewalks and footpaths
      const stepCost = (tileType === 2 || tileType === 3 || tileType === 11) ? 1.0 : 1.45;
      const tentativeG = (gScore.get(current) ?? 1e9) + stepCost;
      
      if (tentativeG < (gScore.get(neighborKey) ?? 1e9)) {
        cameFrom.set(neighborKey, current);
        gScore.set(neighborKey, tentativeG);
        // Manhattan Distance Heuristic
        const hScore = Math.abs(nx - targetX) + Math.abs(ny - targetY);
        fScore.set(neighborKey, tentativeG + hScore);
        if (!openSet.includes(neighborKey)) openSet.push(neighborKey);
      }
    }
  }
  return []; // No route found
}
```

---

## 4. Rendering Pipeline & Depth Sorting

Inside the `requestAnimationFrame` loop in `class xf`, the canvas is rendered in the following order:

1. **Camera Transform:**
   * Supports smooth zoom (`cam.zoom` toward target `cam.tz`).
   * Smooth lerp panning `(cam.x += (cam.tx - cam.x) * 0.08)`.
   * Supports mouse dragging / touch pinch zoom.
2. **Viewport Frustum Culling:**
   Only objects, buildings, and agents inside the screen window (`bounding box + margin`) are sent to the render pipeline.
3. **Depth Sorting (Y-Index Painter's Algorithm):**
   ```javascript
   const renderQueue = [];
   // Insert buildings, props, and agents into a single queue
   for (const b of visibleBuildings) renderQueue.push({ y: b.y + b.h * V, draw: () => drawBuilding(b) });
   for (const p of visibleProps)     renderQueue.push({ y: p.y + V,       draw: () => drawProp(p) });
   for (const a of visibleAgents)    renderQueue.push({ y: a.y,           draw: () => drawAgent(a) });
   
   // Sort by lowest Y coordinate
   renderQueue.sort((a, b) => a.y - b.y);
   
   // Execute drawings in sequence
   for (const item of renderQueue) item.draw();
   ```
   *Result:* An agent walking behind a building will be covered by the building's roof; an agent walking in front of a building will stand realistically on top of the building's floor.

---

## 5. Dynamic Lighting & Day-Night Cycle

The day cycle is governed by the `dayLength = 900` seconds parameter (15 minutes of real time = 1 day in town).

* **Dusk / Evening (`clock > 0.42`):**
  The canvas is overlaid with a transparent warm-orange color filter:
  ```javascript
  ctx.fillStyle = `rgba(255, 170, 90, ${(this.clock - 0.42) * 0.9})`;
  ctx.fillRect(0, 0, width, height);
  ```
* **Nighttime (`night() > 0.01`):**
  The canvas is overlaid with a deep dark-blue filter:
  ```javascript
  ctx.fillStyle = `rgba(22, 28, 60, ${nightIntensity * 0.5})`;
  ctx.fillRect(0, 0, width, height);
  ```
* **Lamp & Bonfire Light Sources (Halo Lighting):**
  Uses `ctx.globalCompositeOperation = "lighter"` blending to draw transparent radial light circles at street lantern points (`lamp`), the bonfire (`fire`), and windows of buildings inhabited by residents.

---

## 6. Speech Bubbles & Spit Interaction

1. **Speech Bubbles on the Canvas:**
   * Speaking agents spawn vintage cartoon-style speech bubbles.
   * Render priority: The llama currently clicked/followed by the user gets the highest priority, followed by the most recent speech.
   * Removed automatically after `bubble.until` expires.
2. **Spit Mechanism:**
   * When an SSE `spit` event is received:
     ```javascript
     spit(attackerId, victimId) {
       const attacker = this.byId.get(attackerId);
       const victim = this.byId.get(victimId);
       attacker.facing = victim.x > attacker.x ? 1 : -1;
       attacker.doing = "spit";
       
       setTimeout(() => {
         // Spawn a moving spit particle
         this.puffs.push({ x: attacker.x + attacker.facing * 22, y: attacker.y - 26, life: 0.8, kind: "spit" });
         // The victim is startled and their mood drops drastically
         victim.doing = "shake";
         victim.mood -= 0.6;
       }, 450);
     }
     ```
   * The spit particle (`#cfe8f2`) travels through the air, hits the victim, and triggers a shake animation on the victim.
