import { Pe } from "./constants.js";

export interface GameMapLike {
  at(x: number, y: number): number;
  solid(x: number, y: number): boolean;
}

function encode(x: number, y: number): number {
  return y * Pe + x;
}

export function pf(map: GameMapLike, startX: number, startY: number, targetX: number, targetY: number): Array<{ x: number; y: number }> {
  if (startX === targetX && startY === targetY) return [];

  const openSet: number[] = [encode(startX, startY)];
  const cameFrom = new Map<number, number>();
  const gScore = new Map<number, number>([[encode(startX, startY), 0]]);
  const fScore = new Map<number, number>([[encode(startX, startY), 0]]);
  const goalKey = encode(targetX, targetY);

  let iterations = 0;
  while (openSet.length && iterations++ < 9000) {
    let bestIdx = 0;
    for (let i = 1; i < openSet.length; i++) {
      if ((fScore.get(openSet[i]!) ?? 1e9) < (fScore.get(openSet[bestIdx]!) ?? 1e9)) bestIdx = i;
    }
    const current = openSet.splice(bestIdx, 1)[0]!;
    if (current === goalKey) {
      const path: Array<{ x: number; y: number }> = [];
      let step: number | undefined = current;
      while (step !== undefined && step !== encode(startX, startY)) {
        path.unshift({ x: step % Pe, y: Math.floor(step / Pe) });
        step = cameFrom.get(step);
      }
      return path;
    }

    const curX = current % Pe;
    const curY = Math.floor(current / Pe);

    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const nx = curX + dx;
      const ny = curY + dy;
      if (map.solid(nx, ny) && !(nx === targetX && ny === targetY)) continue;
      const neighborKey = encode(nx, ny);
      const tileType = map.at(nx, ny);
      const stepCost = tileType === 2 || tileType === 3 || tileType === 11 ? 1.0 : 1.45;
      const tentativeG = (gScore.get(current) ?? 1e9) + stepCost;
      if (tentativeG < (gScore.get(neighborKey) ?? 1e9)) {
        cameFrom.set(neighborKey, current);
        gScore.set(neighborKey, tentativeG);
        const hScore = Math.abs(nx - targetX) + Math.abs(ny - targetY);
        fScore.set(neighborKey, tentativeG + hScore);
        if (!openSet.includes(neighborKey)) openSet.push(neighborKey);
      }
    }
  }
  return [];
}
