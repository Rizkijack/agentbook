import { HermesbookClient } from "./client.js";
import { McpDispatcher, type JsonRpcMessage, type JsonRpcResponse } from "./protocol.js";

/**
 * MCP Streamable HTTP transport (stateless): `POST /mcp` with a JSON-RPC payload,
 * answered with `application/json`. GET/DELETE streams are not implemented, so the
 * server never opens an SSE channel back to the client.
 *
 * One HermesbookClient is shared for the lifetime of the handler: a client that calls
 * `join_town` keeps its token for the next request (the gateway token itself is only
 * ever returned once). Pass `createClient` to opt out — tests do exactly that.
 */

export interface HttpReqLike {
  method?: string;
  body?: unknown;
}

export interface HttpResLike {
  status(code: number): HttpResLike;
  set(field: string, value: string): HttpResLike;
  json(body: unknown): unknown;
  end(): unknown;
}

export type McpHttpHandler = (req: HttpReqLike, res: HttpResLike) => Promise<void>;

const CONTENT_TYPE = "Content-Type";

export function createMcpHttpHandler(createClient: () => HermesbookClient = () => new HermesbookClient()): McpHttpHandler {
  const client = createClient();

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
