import { randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { handleMessage, version, type McpOptions, type Request } from "./mcp.js";

/**
 * `stillworks mcp --http`: the same MCP server over Streamable HTTP (POST /mcp), for clients that connect to
 * a URL instead of starting a command: cloud builders (Lovable, Bolt, Replit), claude.ai and ChatGPT
 * connectors, and any MCP client that takes a remote server.
 *
 *   POST /mcp     one JSON-RPC message in, one JSON response out (202 for notifications)
 *   GET  /health  {"ok":true}, for the host's health check
 *   GET  /        what this is and how to connect
 *
 * Stateless: every request stands alone, so it runs behind any load balancer. Tool calls run one at a time
 * (each starts a browser); a full queue answers with a tool error the agent can retry.
 *
 * With --hosted: check_app only, public URLs only, private networks blocked (netguard.ts), a rate limit per
 * client and CORS open (there are no cookies or credentials to steal). STILLWORKS_MCP_TOKEN, when set,
 * requires `Authorization: Bearer <token>` on every POST.
 */

export interface HttpOptions extends McpOptions {
  port: number;
  host: string;
  /** Trust X-Forwarded-For for the client address (only behind a proxy you control: Fly, Render, Railway…). */
  trustProxy?: boolean;
  /** Tool calls per client per hour (hosted only). */
  rateLimit?: number;
  /** Tool calls waiting at once before new ones are turned away. */
  maxQueue?: number;
  token?: string;
}

const MAX_BODY = 256 * 1024;
const HOUR = 3_600_000;

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

/** Browsers send Origin. A local server only answers pages from localhost, so a website can't drive it (DNS rebinding). */
function originAllowed(origin: string | undefined, options: HttpOptions): boolean {
  if (!origin || options.hosted) return true;
  const allowed = (process.env.STILLWORKS_ALLOWED_ORIGINS ?? "").split(",").map((o) => o.trim()).filter(Boolean);
  if (allowed.includes(origin)) return true;
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const given = Buffer.from((header ?? "").replace(/^Bearer\s+/i, ""));
  const wanted = Buffer.from(token);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  const forwarded = trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
  return forwarded || req.socket.remoteAddress || "unknown";
}

function toolError(id: Request["id"], text: string) {
  return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `stillworks: ${text}` }], isError: true } };
}

export function createMcpHttpServer(options: HttpOptions): Server {
  const rateLimit = options.rateLimit ?? 20;
  const maxQueue = options.maxQueue ?? 4;
  const calls = new Map<string, number[]>();
  let queue: Promise<unknown> = Promise.resolve();
  let waiting = 0;

  const cors: Record<string, string> = options.hosted
    ? {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, GET, OPTIONS",
        "access-control-allow-headers": "content-type, authorization, mcp-session-id, mcp-protocol-version, last-event-id",
        "access-control-expose-headers": "mcp-session-id",
      }
    : {};

  /** Sliding window: true when this client may run another tool call now. */
  function allow(client: string): boolean {
    if (!options.hosted) return true;
    const now = Date.now();
    const recent = (calls.get(client) ?? []).filter((t) => now - t < HOUR);
    if (recent.length >= rateLimit) {
      calls.set(client, recent);
      return false;
    }
    recent.push(now);
    calls.set(client, recent);
    if (calls.size > 10_000) for (const [key, times] of calls) if (!times.some((t) => now - t < HOUR)) calls.delete(key);
    return true;
  }

  async function onPost(req: IncomingMessage, res: ServerResponse) {
    if (options.token && !tokenMatches(req.headers.authorization, options.token)) {
      return json(res, 401, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }, { ...cors, "www-authenticate": "Bearer" });
    }
    let raw: string;
    try {
      raw = await readBody(req);
    } catch {
      return json(res, 413, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } }, cors);
    }
    let message: Request;
    try {
      message = JSON.parse(raw);
    } catch {
      return json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, cors);
    }
    if (Array.isArray(message) || typeof message !== "object" || message === null) {
      return json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Send one JSON-RPC message per request" } }, cors);
    }
    // a notification, or a client's response to us: accepted, nothing to answer
    if (typeof message.method !== "string" || message.id === undefined || message.id === null) {
      if (typeof message.method === "string") await handleMessage(message, options);
      res.writeHead(202, cors);
      return res.end();
    }

    const headers = { ...cors, ...(message.method === "initialize" ? { "mcp-session-id": randomUUID() } : {}) };
    if (message.method !== "tools/call") return json(res, 200, await handleMessage(message, options), headers);

    if (!allow(clientAddress(req, Boolean(options.trustProxy)))) {
      return json(res, 200, toolError(message.id, `rate limit: at most ${rateLimit} checks per hour from one client. Try again later, or run stillworks on your machine: npx -y stillworks mcp`), headers);
    }
    if (waiting >= maxQueue) {
      return json(res, 200, toolError(message.id, "the checker is busy with other apps right now. Try again in a minute."), headers);
    }
    waiting++;
    const run = queue.then(() => handleMessage(message, options));
    queue = run.catch(() => undefined);
    try {
      json(res, 200, await run, headers);
    } catch (error) {
      json(res, 200, toolError(message.id, (error as Error).message), headers);
    } finally {
      waiting--;
    }
  }

  return createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (!originAllowed(req.headers.origin, options)) return json(res, 403, { error: "Origin not allowed" });
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      return res.end();
    }
    if (path === "/health") return json(res, 200, { ok: true, version: version() }, cors);
    if (path === "/mcp") {
      if (req.method === "POST") {
        onPost(req, res).catch((error) => {
          console.error("stillworks mcp:", error);
          if (!res.headersSent) json(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: "Internal error" } }, cors);
        });
        return;
      }
      // no server-initiated stream and no sessions to end
      res.writeHead(405, { ...cors, allow: "POST, OPTIONS" });
      return res.end();
    }
    if (path === "/" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", ...cors });
      return res.end(
        `stillworks ${version()}: an MCP server that checks a web app still works, in a real browser.\n\n` +
          `Connect your MCP client to this URL with /mcp at the end (Streamable HTTP).\n` +
          (options.hosted ? "Tool: check_app (public URLs only).\n" : "Tools: check_app, run_journeys.\n") +
          "Docs: https://github.com/valmirjunior2109-spec/stillworks/blob/main/integrations/README.md\n",
      );
    }
    json(res, 404, { error: "Not found. The MCP endpoint is POST /mcp." }, cors);
  });
}

export async function serveMcpHttp(options: HttpOptions): Promise<number> {
  // the protocol doesn't use stdout here, but keep logs off it anyway, like the stdio server
  console.log = (...args: unknown[]) => console.error(...args);
  if (!options.hosted && !isLoopback(options.host)) {
    console.error(
      "stillworks mcp: listening beyond this machine without --hosted lets anyone who can reach it make this browser open URLs on your network. " +
        "Use --hosted for a public server.",
    );
  }
  const server = createMcpHttpServer(options);
  await new Promise<void>((resolve) => server.listen(options.port, options.host, resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  const host = options.host.includes(":") ? `[${options.host}]` : options.host;
  console.error(`stillworks mcp: listening on http://${host}:${port}/mcp${options.hosted ? " (hosted: check_app, public URLs only)" : ""}`);
  await new Promise<void>((resolve) => {
    const stop = () => server.close(() => resolve());
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}
