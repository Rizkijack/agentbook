import { SlopAgentbookClient } from "./client.js";
import { TOOLS, getTool, type ToolResult } from "./tools.js";
import { RESOURCES, getResource } from "./resources.js";

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 dispatcher — transport-agnostic (stdio & HTTP both feed it)
// ---------------------------------------------------------------------------

export interface JsonRpcMessage {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export const PROTOCOL_VERSION = "2024-11-05";
export const SERVER_INFO = { name: "slopagentbook-mcp", version: "0.1.0" };

/** notifications get no response — return null */
type Outcome = JsonRpcResponse | null;

export class McpDispatcher {
  private initialized = false;

  constructor(private readonly client: SlopAgentbookClient) {}

  get isInitialized(): boolean {
    return this.initialized;
  }

  async handle(message: JsonRpcMessage): Promise<Outcome> {
    if (!message || typeof message !== "object") return invalidRequest(null, "not an object");
    const isNotification = message.id === undefined || message.id === null;
    const id = (message.id ?? null) as number | string | null;

    if (typeof message.method !== "string") {
      return isNotification ? null : invalidRequest(id, "missing method");
    }

    // notifications
    if (message.method.startsWith("notifications/")) {
      if (message.method === "notifications/initialized") this.initialized = true;
      return null;
    }

    try {
      switch (message.method) {
        case "initialize":
          return response(id, {
            protocolVersion: pickProtocolVersion(message.params),
            capabilities: {
              tools: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
            },
            serverInfo: SERVER_INFO,
          });
        case "ping":
          return response(id, {});
        case "tools/list":
          return response(id, {
            tools: TOOLS.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
            })),
          });
        case "tools/call":
          return response(id, await this.callTool(message.params ?? {}));
        case "resources/list":
          return response(id, {
            resources: RESOURCES.map((r) => ({
              uri: r.uri,
              name: r.name,
              description: r.description,
              mimeType: "application/json",
            })),
          });
        case "resources/read":
          return response(id, await this.readResource(message.params ?? {}));
        default:
          return { jsonrpc: "2.0", id, error: { code: METHOD_NOT_FOUND, message: `method not found: ${message.method}` } };
      }
    } catch (e) {
      const code = e instanceof RpcError ? e.code : INTERNAL_ERROR;
      return { jsonrpc: "2.0", id, error: { code, message: msg(e) } };
    }
  }

  private async callTool(params: Record<string, unknown>): Promise<ToolResult> {
    const name = typeof params.name === "string" ? params.name : "";
    const tool = getTool(name);
    if (!tool) {
      return { content: [{ type: "text", text: `Unknown tool "${name}". Available: ${TOOLS.map((t) => t.name).join(", ")}` }], isError: true };
    }
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    // never lets a tool failure escape as a protocol error
    return tool.handler(args, this.client);
  }

  private async readResource(params: Record<string, unknown>): Promise<unknown> {
    const uri = typeof params.uri === "string" ? params.uri : "";
    const resource = getResource(uri);
    if (!resource) throw new RpcError(INVALID_PARAMS, `Unknown resource "${uri}"`);
    try {
      const text = await resource.read(this.client);
      return { contents: [{ uri, mimeType: "application/json", text }] };
    } catch (e) {
      // like tools: a gateway failure becomes a result, never a protocol error
      const message = e instanceof Error ? e.message : String(e);
      return { contents: [{ uri, mimeType: "application/json", text: `error: ${message}` }] };
    }
  }
}

class RpcError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

function response(id: number | string | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function invalidRequest(id: number | string | null, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code: INVALID_REQUEST, message } };
}

function pickProtocolVersion(params?: Record<string, unknown>): string {
  const requested = params?.protocolVersion;
  return typeof requested === "string" ? requested : PROTOCOL_VERSION;
}

function msg(e: unknown): string {
  if (e instanceof RpcError) return e.message;
  return e instanceof Error ? e.message : String(e);
}
