// @ts-nocheck
// Vercel serverless entry — mounts the Express app from backend/src/server.ts
// Route all /api/* here via vercel.json rewrites.
import { app } from "../backend/src/server.js";

export const config = {
  // allow SSE streaming responses
  supportsResponseStreaming: true,
};

export default function handler(
  req: import("http").IncomingMessage,
  res: import("http").ServerResponse
): void {
  // Express app is a standard (req, res) listener
  (app as unknown as (r: unknown, s: unknown) => void)(req, res);
}
