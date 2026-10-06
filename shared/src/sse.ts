import type { Resident, TownConfig } from "./types.js";

export type SSEOrder = { type: "order"; id: string; act: string; place: string; secs: number };
export type SSEPost = { type: "post"; post: import("./types.js").Post };
export type SSELlama = { type: "llama"; llama: Resident };
export type SSEHerd = { type: "herd"; herd: Resident[] };
export type SSEEdition = { type: "edition"; edition: import("./types.js").Edition };
export type SSEEvent = { type: "event"; event: import("./types.js").TownEvent };
export type SSESpit = { type: "spit"; from: string; to: string };
export type SSEConfig = { type: "config"; config: TownConfig };

export type SSEMessage = SSEOrder | SSEPost | SSELlama | SSEHerd | SSEEdition | SSEEvent | SSESpit | SSEConfig;

export function encodeSSE(msg: SSEMessage): string {
  return `data: ${JSON.stringify(msg)}\n\n`;
}
