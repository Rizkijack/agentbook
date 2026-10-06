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
  width:  Pe * V,     // 210 * 16 = 3.360 pixels
  height: vt * V      // 128 * 16 = 2.048 pixels
};
```

The **3.360 x 2.048 pixel** map is generated procedurally at initialization using a seeded PRNG (`df(20260921)`), producing grassy hills, river streams, ponds, dirt roads, and stone footpaths.

---

## 2. Catalog of 26 Town Locations (`_n`)

The Llamabook world has 26 points of interest grouped into functional categories:

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
