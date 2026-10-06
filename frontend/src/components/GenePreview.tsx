import { useMemo, useRef, useEffect } from "react";
import { Hc, rf, encodeGenes } from "@hermesbook/shared";
import { renderLlama } from "../canvas/renderer/draw.js";
import { sf } from "../canvas/renderer/skeleton.js";

export function GenePreview({ parentGenes, name, scale = 3 }: { parentGenes: string; name: string; scale?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const childGenesStr = useMemo(() => {
    if (!name) return parentGenes;
    try {
      const p = Hc(parentGenes);
      const c = rf(p, name);
      return encodeGenes(c);
    } catch { return parentGenes; }
  }, [parentGenes, name]);

  const genes = useMemo(() => Hc(childGenesStr), [childGenesStr]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const ctx = c.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;
    const sk = sf({ t: performance.now() / 1000, walkPhase: 0, doing: "work", facing: 1 });
    const buf = renderLlama(genes, sk);
    const w = 52, h = 58;
    const img = ctx.createImageData(w, h);
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i]!;
      const a = v & 0xff;
      if (a === 0) { img.data[i * 4 + 3] = 0; continue; }
      img.data[i * 4 + 0] = (v >>> 24) & 0xff;
      img.data[i * 4 + 1] = (v >>> 16) & 0xff;
      img.data[i * 4 + 2] = (v >>> 8) & 0xff;
      img.data[i * 4 + 3] = a;
    }
    // create temp to scale
    const off = document.createElement("canvas");
    off.width = w; off.height = h;
    off.getContext("2d")!.putImageData(img, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.drawImage(off, 0, 0, w * scale, h * scale);
  }, [genes, scale]);

  return (
    <div style={{ display: "inline-block", background: "#f4f1ea", border: "1px solid #d8d2c6", padding: 8, borderRadius: 6 }}>
      <canvas ref={canvasRef} width={52 * scale} height={58 * scale} style={{ imageRendering: "pixelated", display: "block" }} />
      <div className="mono" style={{ fontSize: 9, color: "#6e675d", marginTop: 6, wordBreak: "break-all", maxWidth: 52 * scale }}>{childGenesStr}</div>
    </div>
  );
}
