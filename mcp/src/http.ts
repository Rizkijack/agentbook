import { SlopAgentbookClient } from "./client.js";
import { McpDispatcher, type JsonRpcMessage, type JsonRpcResponse } from "./protocol.js";

/**
 * MCP Streamable HTTP transport (stateless): `POST /mcp` with a JSON-RPC payload,
 * answered with `application/json`. GET/DELETE streams are not implemented, so the
 * server never opens an SSE channel back to the client.
 *
 * Token discipline: the transport is stateless, so a client may never outlive the
 * request that proved ownership of it. Every POST gets a fresh SlopAgentbookClient —
 * precedence `Authorization: Bearer <token>` header of THIS call > env
 * SLOPAGENTBOOK_TOKEN — and `join_town` only shares its token with the rest of the
 * same request (a JSON-RPC batch). The gateway token is returned once; the caller
 * sends it back as the Authorization header on the next call. A single shared
 * client would let caller A's `join_town` token authenticate caller B's `act`.
 * Pass `createClient` to inject — tests do exactly that.
 */

export interface HttpReqLike {
  method?: string;
  body?: unknown;
  /** Express/Node headers — optional so bare test stubs keep compiling. */
  headers?: Record<string, string | string[] | undefined>;
}

export interface HttpResLike {
  status(code: number): HttpResLike;
  set(field: string, value: string): HttpResLike;
  json(body: unknown): unknown;
  end(): unknown;
}

export type McpHttpHandler = (req: HttpReqLike, res: HttpResLike) => Promise<void>;

const CONTENT_TYPE = "Content-Type";

export function createMcpHttpHandler(createClient: () => SlopAgentbookClient = () => new SlopAgentbookClient()): McpHttpHandler {
  return async function mcpHttp(req: HttpReqLike, res: HttpResLike): Promise<void> {
    if ((req.method ?? "GET").toUpperCase() !== "POST") {
      res.status(405).set("Allow", "POST").json({
        error: "method not allowed — MCP Streamable HTTP uses POST /mcp",
      });
      return;
    }

    let payload: unknown;
    try {
      payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    } catch {
      sendJsonRpc(res, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }

    if (payload === undefined || payload === null) {
      sendJsonRpc(res, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "missing body" } });
      return;
    }

    // Fresh client per request: no token may outlive the call that carried it
    // (see the file header). Bearer header of THIS call wins over the env default.
    const client = createClient();
    const bearer = bearerToken(req.headers);
    if (bearer) client.token = bearer;

    // each request gets a fresh dispatcher (stateless): initialize is not required
    // before tools/list, and no session id is negotiated.
    const dispatcher = new McpDispatcher(client);

    if (Array.isArray(payload)) {
      const replies: JsonRpcResponse[] = [];
      for (const item of payload as JsonRpcMessage[]) {
        const out = await safeHandle(dispatcher, item);
        if (out) replies.push(out);
      }
      if (replies.length === 0) {
        // batch of notifications only — accepted, no body
        res.status(202).set(CONTENT_TYPE, "text/plain").end();
        return;
      }
      sendJsonRpc(res, replies);
      return;
    }

    const out = await safeHandle(dispatcher, payload as JsonRpcMessage);
    if (!out) {
      // notification (e.g. notifications/initialized) — 202, no content
      res.status(202).set(CONTENT_TYPE, "text/plain").end();
      return;
    }
    sendJsonRpc(res, out);
  };
}

async function safeHandle(dispatcher: McpDispatcher, message: JsonRpcMessage): Promise<JsonRpcResponse | null> {
  try {
    return await dispatcher.handle(message);
  } catch (e) {
    return {
      jsonrpc: "2.0",
      id: message?.id ?? null,
      error: { code: -32603, message: e instanceof Error ? e.message : String(e) },
    };
  }
}

function sendJsonRpc(res: HttpResLike, body: JsonRpcResponse | JsonRpcResponse[]): void {
  res.status(200).set(CONTENT_TYPE, "application/json; charset=utf-8").json(body);
}

/** `Authorization: Bearer <token>` from this request's headers, if present. */
function bearerToken(headers?: Record<string, string | string[] | undefined>): string | undefined {
  const raw = headers?.authorization ?? headers?.Authorization;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const m = /^Bearer\s+(.+)$/i.exec((value ?? "").trim());
  return m ? m[1]!.trim() : undefined;
}
