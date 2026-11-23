import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { isLocalURL, resolveBaseURL } from "./args.js";
import { DEFAULT_CONFIG_FILE, UsageError, isExampleConfig, loadConfig } from "./config.js";
import { writeReport } from "./report.js";
import { runJourneys, type RunResult } from "./runner.js";
import { PACKAGE_ROOT } from "./setup.js";
import { MAX_EXTRA_PAGES, discover, pickPages, smokeConfig } from "./smoke.js";

/**
 * `stillworks mcp`: an MCP server over stdio, so Claude Code, Cursor and other agents can check the app
 * themselves after a change. Two tools:
 *
 *   check_app     zero setup, read-only: the URL and the key pages linked from it
 *   run_journeys  the journeys in journeys.config.ts (signup, login, checkout…)
 *
 * Both return the same REPORT.md the CLI writes. stdout carries only protocol messages; logs go to stderr.
 * Nothing is sent anywhere except to the URL being checked.
 */

const OUT_DIR = "verify-report";

const TOOLS = [
  {
    name: "check_app",
    description:
      "Open a web app in a real browser and check it still works, with zero setup. Visits the URL and up to 6 key pages linked from it " +
      "(signup, login, pricing, dashboard first) and reports pages that don't load, 'not found' screens, blank pages, uncaught JavaScript " +
      "errors and 5xx responses from the app's API, with the failed requests and their responses. Read-only: never fills forms or clicks " +
      "buttons. Use it after changing a web app, before saying the work is done. Returns a report written as instructions for fixing.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string", description: "The app to check, e.g. http://localhost:3000 or https://my-app.vercel.app" } },
      required: ["url"],
      additionalProperties: false,
    },
  },
  {
    name: "run_journeys",
    description:
      "Run the user journeys defined in journeys.config.ts (for example signup, login, checkout) in a real browser and report which step " +
      "failed, with console errors, failed requests and the server's response. Use after changing a flow those journeys cover. " +
      "If there is no journeys.config.ts, use check_app instead or create one with `npx stillworks init`.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "The app to check. Defaults to baseURL in the config." },
        config: { type: "string", description: `Config file, default ${DEFAULT_CONFIG_FILE}.` },
        journeys: { type: "array", items: { type: "string" }, description: "Only run these journeys, by name." },
      },
      additionalProperties: false,
    },
  },
] as const;

interface Request {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

function send(message: unknown) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function version(): string {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version;
}

async function reachable(url: string) {
  try {
    await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new UsageError(`Couldn't reach ${url}. Is the app running? Start it, or pass the deployed URL.`);
  }
}

function summary(result: RunResult, noun: "page" | "journey"): string {
  const failed = result.journeys.filter((j) => j.status === "failed");
  const ran = result.journeys.filter((j) => j.status !== "skipped").length;
  const plural = (n: number) => `${n} ${noun}${n === 1 ? "" : "s"}`;
  return failed.length
    ? `stillworks: ${failed.length} of ${plural(ran)} failed (${failed.map((j) => j.name).join(", ")}). Read the report below and fix the root cause.`
    : `stillworks: all ${plural(ran)} passed.`;
}

async function checkApp(args: Record<string, unknown>): Promise<string> {
  if (typeof args.url !== "string" || !args.url.trim()) throw new UsageError("Pass the app's URL, e.g. http://localhost:3000.");
  const url = resolveBaseURL(args.url, {});
  await reachable(url);
  const { finalURL, links } = await discover(url, {});
  const startPath = `${finalURL.pathname}${finalURL.search}` || "/";
  const config = smokeConfig(startPath, pickPages(links, finalURL, MAX_EXTRA_PAGES));
  const result = await runJourneys(config, { baseURL: finalURL.origin, outDir: OUT_DIR });
  const paths = writeReport(result, OUT_DIR, { rerun: `the check_app tool with url ${url}`, badge: false });
  return `${summary(result, "page")}\n\n${readFileSync(paths.markdown, "utf8")}`;
}

async function runConfigured(args: Record<string, unknown>): Promise<string> {
  const file = typeof args.config === "string" && args.config.trim() ? args.config : DEFAULT_CONFIG_FILE;
  const { config, path } = await loadConfig(file);
  const url = resolveBaseURL(typeof args.url === "string" ? args.url : undefined, config);
  const template = readFileSync(join(PACKAGE_ROOT, "templates", "journeys.config.ts"), "utf8");
  if (!isLocalURL(url) && isExampleConfig(readFileSync(path, "utf8"), template)) {
    throw new UsageError(`${file} still has the example journeys, which create accounts and submit forms. Change them to match the app first.`);
  }
  await reachable(url);
  const only = Array.isArray(args.journeys) ? args.journeys.filter((j): j is string => typeof j === "string") : undefined;
  const result = await runJourneys(config, { baseURL: url, outDir: OUT_DIR, only });
  const paths = writeReport(result, OUT_DIR, { rerun: "the run_journeys tool", badge: false });
  return `${summary(result, "journey")}\n\n${readFileSync(paths.markdown, "utf8")}`;
}

async function handle(request: Request): Promise<void> {
  const { id, method, params = {} } = request;
  const reply = (result: unknown) => id !== undefined && id !== null && send({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string) => id !== undefined && id !== null && send({ jsonrpc: "2.0", id, error: { code, message } });

  switch (method) {
    case "initialize":
      return void reply({
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "stillworks", version: version() },
        instructions: "After changing a web app, call check_app (or run_journeys if the project has journeys.config.ts) before saying the work is done, and fix what the report says.",
      });
    case "ping":
      return void reply({});
    case "tools/list":
      return void reply({ tools: TOOLS });
    case "tools/call": {
      const name = params.name;
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        const text = name === "check_app" ? await checkApp(args) : name === "run_journeys" ? await runConfigured(args) : null;
        if (text === null) return void fail(-32602, `Unknown tool: ${String(name)}`);
        return void reply({ content: [{ type: "text", text }] });
      } catch (error) {
        // a setup problem (app not running, no config) is a tool error the agent can act on, not a protocol error
        return void reply({ content: [{ type: "text", text: `stillworks: ${(error as Error).message}` }], isError: true });
      }
    }
    default:
      if (method.startsWith("notifications/")) return;
      return void fail(-32601, `Method not found: ${method}`);
  }
}

export async function serveMcp(): Promise<number> {
  // stdout is the protocol: anything else printed there would corrupt it
  console.log = (...args: unknown[]) => console.error(...args);
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let queue = Promise.resolve();
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request: Request;
    try {
      request = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    // one tool call at a time: each one starts a browser
    queue = queue.then(() => handle(request)).catch((error) => console.error("stillworks mcp:", error));
  }
  await queue;
  return 0;
}
