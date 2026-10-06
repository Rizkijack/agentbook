export interface AnimState {
  t: number; // time sec
  walkPhase: number; // 0..1
  doing: string;
  facing: 1 | -1;
}

export interface Skeleton {
  legs: Array<[number, number]>;
  bodyY: number;
  bodyTilt: number;
  neckLean: number;
  neckCurve: number;
  headTilt: number;
  jaw: number;
  lid: number; // 0 open, 1 closed
  earL: number;
  earR: number;
  tail: number;
}

let lastBlink = 0;
let blinkUntil = 0;
let nextEarTwitch = 2.5;

export function sf(anim: AnimState): Skeleton {
  const movingActs = new Set(["work", "graze", "wander", "stroll", "explore", "talk", "argue", "drink"]);
  const isMoving = movingActs.has(anim.doing);
  const amp = anim.doing === "explore" ? 1.15 : anim.doing === "graze" ? 0.9 : anim.doing === "talk" ? 0.55 : anim.doing === "drink" ? 0.5 : 1.0;
  const walk = isMoving ? Math.sin(anim.walkPhase * Math.PI * 2) * amp : 0;
  const bodyY = Math.abs(walk) * 1.25;
  const bodyTilt = walk * 0.065;
  const tail = Math.sin(anim.t * 3.2) * 0.5 + walk * 0.32;
  const neckLean = walk * 0.085;
  const neckCurve = Math.sin(anim.t * 1.1) * 0.05 + walk * 0.03;

  // blink logic 2.4-6.4s, lid 0.14s
  if (anim.t - lastBlink > 2.4 + (anim.t % 4) * 0.6) {
    // pseudo random interval based on t
    lastBlink = anim.t;
    blinkUntil = anim.t + 0.14;
  }
  const lid = anim.t < blinkUntil ? 1 : 0;

  // ear twitch 2.5-7.5
  if (anim.t > nextEarTwitch) {
    nextEarTwitch = anim.t + 2.5 + (anim.t % 5);
  }
  const earPhase = Math.sin(anim.t * 18) * 0.08 * (Math.abs(anim.t - nextEarTwitch) < 0.2 ? 1 : 0);

  return {
    legs: [
      [12 + walk * 2, 44],
      [20 + walk * -2, 44],
      [32 + walk * 2, 44],
      [40 + walk * -2, 44],
    ],
    bodyY,
    bodyTilt,
    neckLean,
    neckCurve,
    headTilt: walk * 0.05,
    jaw: anim.doing === "graze" ? Math.abs(Math.sin(anim.t * 6)) * 0.6 : 0,
    lid,
    earL: earPhase,
    earR: -earPhase,
    tail,
  };
}

export function resetBio(): void {
  lastBlink = 0;
  blinkUntil = 0;
  nextEarTwitch = 2.5;
}
