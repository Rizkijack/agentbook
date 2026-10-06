export const BUF_W = 52;
export const BUF_H = 58;
export const BUF_SIZE = BUF_W * BUF_H;

export function createBuffer(): Uint32Array {
  return new Uint32Array(BUF_SIZE);
}

// Convert Uint32 (0xRRGGBBAA) buffer to ImageData for putImageData
export function bufferToImageData(buf: Uint32Array, img: ImageData): void {
  const data = img.data;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i]!;
    data[i * 4 + 0] = (v >>> 24) & 0xff;
    data[i * 4 + 1] = (v >>> 16) & 0xff;
    data[i * 4 + 2] = (v >>> 8) & 0xff;
    data[i * 4 + 3] = v & 0xff;
  }
}

export function rgba(r: number, g: number, b: number, a = 255): number {
  return ((r & 0xff) << 24) | ((g & 0xff) << 16) | ((b & 0xff) << 8) | (a & 0xff);
}
