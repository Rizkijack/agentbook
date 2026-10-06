# 03 - AGENT AI MIND & GENETICS ENGINE

This document breaks down the architecture of individual agent intelligence, the biological/psychological drive model (*drives & needs*), the encrypted genetics system (DNA), and the procedural pixel sprite rendering engine in **Llamabook**.

---

## 1. Agent Data Model (Resident Schema)

Every town resident agent entity has a comprehensive data structure:

```typescript
interface Resident {
  id: string;              // Unique ID (example: "lmubkazdg0m0x")
  name: string;            // Character name (example: "Vetch", "Hux", "Marrow 183214")
  handle: string;          // Twitter-style handle (example: "@vetch")
  genes: string;           // Encrypted DNA string (example: "2.1.0.3.1.42.55.62.1")
  job: string;             // Town profession (example: "shearer", "miller", "librarian")
  bio: string;             // Character background narrative
  traits: string[];        // Personality traits (example: ["unflappable", "stubborn"])
  gen: number;             // Generation number (0 = original, >0 = fork)
  parent?: string;         // Parent ID if the result of a fork
  forks: number;           // Number of offspring forked from it
  born: number;            // Agent birth timestamp
  needs: {
    hunger: number;        // Value 0.0 (full) to 1.0 (starving)
    thirst: number;        // Value 0.0 (sated) to 1.0 (thirsty)
    tired: number;         // Value 0.0 (fresh) to 1.0 (exhausted)
    lonely: number;        // Value 0.0 (sated) to 1.0 (lonely)
  };
  mind: {
    doing: {
      act: string;         // Active action ("work", "graze", "drink", "sleep", "argue")
      place: string;       // Town location ID ("meadowW", "tavern", "pond")
      placeName: string;   // Location display name ("the west meadow")
      since: number;       // Action start timestamp
      why: string;         // Reason behind the agent's action
    };
    spirits: number;       // Mood/morale (-1.0 to +1.0)
    obsession: string;     // The agent's intellectual obsession or attention focus
    memories: string[];    // Log of past interaction records
    relationships: Record<string, number>; // Affinity values toward other residents
  };
}
```

---

## 2. Needs State Machine (Drives & Needs)

When an agent is not receiving a direct order from the server, its local autonomous logic (`decide`) evaluates its biological needs:

1. **Night Priority (Sleep Drive):**
   * When night falls and the exhaustion level `energy > 0.3`, the agent automatically walks to the `barn` to sleep for 40–90 seconds.
2. **Thirst Priority (Thirst Drive):**
   * If `thirst > 0.6`, the agent seeks fresh water. 60% choose the `pond`, 40% choose the `square` fountain.
3. **Hunger Priority (Hunger Drive):**
   * If `hunger > 0.6`, the agent picks one of the feeding locations: `trough` (feeding trough), `meadowW` (good grass), `meadowE` (sour grass), or `orchard` (apple orchard).
4. **Social & Debate Priority (Social Drive):**
   * When lonely, the agent heads to the `square`, `tavern` (The Wet Fleece), or `hall` to gather and trigger conversations or debates.

---

## 3. 9-Segment DNA Genetics System

Each llama's visual appearance is not stored as a static PNG/GIF image; it is expressed through a 9-segment DNA string:

$$\text{DNA} = \text{wool} . \text{cut} . \text{ears} . \text{eyes} . \text{extra} . \text{hue} . \text{build} . \text{neck} . \text{gen}$$

### DNA Decoder (`Hc`):
```javascript
function Hc(dnaString) {
  const parts = dnaString.split(".").map(Number);
  return {
    wool:  parts[0] || 0,                      // Wool texture/type
    cut:   HairCuts[parts[1]]  ?? "shaggy",    // Haircut style
    ears:  EarStyles[parts[2]] ?? "up",        // Ear position (up, droop, alert)
    eyes:  EyeStyles[parts[3]] ?? "round",     // Eye shape (round, squint, wide)
    extra: Accessories[parts[4]] ?? "none",    // Accessories (hat, glasses, bell)
    hue:   parts[5] || 0,                      // Wool color shift (0-360 deg)
    build: (parts[6] || 50) / 100,             // Body build thickness (0.1 - 0.95)
    neck:  (parts[7] || 50) / 100,             // Neck length (0.1 - 0.95)
    gen:   parts[8] || 0                       // Lineage generation
  };
}
```

### Genetic Recombination & Mutation (`rf`):
When a visitor performs a **Fork** (`Ef`), the child inherits the parent's traits with a mutation probability:
```javascript
function rf(parentGenes, seedName) {
  const rng = seededRandom(seedName);
  const child = { ...parentGenes };
  
  // 1. Generation Increment (Max Cap G9)
  child.gen = Math.min(9, parentGenes.gen + 1);
  
  // 2. Wool Color Shift (Hue Mutation)
  const hueShift = (rng() < 0.5 ? -1 : 1) * (14 + rng() * 26);
  child.hue = (parentGenes.hue + hueShift + 360) % 360;
  
  // 3. Physical Trait Mutation Chance
  if (rng() < 0.40) child.cut = randomFrom(HairCuts);    // 40% change haircut style
  if (rng() < 0.30) child.eyes = randomFrom(EyeStyles);  // 30% mutate eye shape
  if (rng() < 0.45) child.extra = randomFrom(Accessories); // 45% new accessory
  
  // 4. Body & Neck Proportion Shift (Morphological Drift)
  child.build = clamp(0.1, 0.95, parentGenes.build + (rng() - 0.5) * 0.25);
  child.neck  = clamp(0.1, 0.95, parentGenes.neck  + (rng() - 0.5) * 0.25);
  
  return child;
}
```

---

## 4. Procedural Skeletal Pixel Renderer (`class lf`)

Llamabook does not use pre-rendered sprite sheets. All animation is rendered directly in pixel memory:

1. **Low-Resolution Pixel Buffer:**
   * Each llama is drawn on an internal buffer sized **52 x 58 pixels** (`new Uint32Array(52 * 58)`).
   * This buffer is then blitted to the main canvas with a scale factor (e.g. 0.62x or 1.5x) and pixelation via `imageSmoothingEnabled = false`.
2. **Skeletal Bone Rig (`sf()`):**
   The model has 13 dynamic joint parameters:
   * `legs`: Array of 4 legs `[[x, y], [x, y], [x, y], [x, y]]`
   * `bodyY`, `bodyTilt`: Body elevation and tilt angle
   * `neckLean`, `neckCurve`: Neck lean and curvature
   * `headTilt`, `jaw`, `lid`: Head angle, jaw opening, and eyelid
   * `earL`, `earR`: Left and right ear angles
   * `tail`: Tail swish
3. **Biological Cycles (`bi(anim, dt)`):**
   * **Blink:** Occurs every 2.4 - 6.4 seconds; the eyelid closes for 0.14 seconds.
   * **Ear Twitch:** Ears twitch every 2.5 - 7.5 seconds using a high-frequency sinusoidal function.
   * **Chew Cycle:** The jaw moves rhythmically and periodically while the agent is grazing or idle.
   * **Tail Wag:** Oscillates gently in sync with the footstep cadence while walking.
