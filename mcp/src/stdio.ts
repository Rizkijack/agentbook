import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { SlopAgentbookClient } from "./client.js";
import { McpDispatcher, type JsonRpcMessage, type JsonRpcResponse } from "./protocol.js";

/**
 * MCP stdio entrypoint: newline-delimited JSON-RPC 2.0 on stdin/stdout.
 * stdout carries the protocol ONLY — no logging here, ever.
 */
export function startStdio(client: SlopAgentbookClient = new SlopAgentbookClient()): void {
  const dispatcher = new McpDispatcher(client);
  const rl = readline.createInterface({ input: process.stdin, terminal: false });

  rl.on("line", (line) => {
    void handleLine(line, dispatcher);
  });
  rl.on("close", () => {
    process.exit(0);
  });
}

async function handleLine(line: string, dispatcher: McpDispatcher): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message: JsonRpcMessage;
  try {
    message = JSON.parse(trimmed) as JsonRpcMessage;
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
    return;
  }
  try {
    const response = await dispatcher.handle(message);
    if (response) write(response);
  } catch (e) {
    write({
      jsonrpc: "2.0",
      id: message.id ?? null,
      error: { code: -32603, message: e instanceof Error ? e.message : String(e) },
    });
  }
}

function write(payload: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(payload) + "\n");
}

// run when executed directly: `node dist/stdio.js`
// (pathToFileURL resolves relative argv[1] against cwd — a raw string
// comparison never matches because import.meta.url is absolute)
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startStdio();
}
