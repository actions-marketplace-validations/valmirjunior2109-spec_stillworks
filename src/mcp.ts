import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { isLocalURL, resolveBaseURL } from "./args.js";
import { assertPublicURL } from "./netguard.js";
import { DEFAULT_CONFIG_FILE, UsageError, isExampleConfig, loadConfig } from "./config.js";
import { writeReport } from "./report.js";
import { runJourneys, type RunResult } from "./runner.js";
import { PACKAGE_ROOT } from "./setup.js";
import { MAX_EXTRA_PAGES, discover, pickPages, smokeConfig } from "./smoke.js";

/**
 * `stillworks mcp`: an MCP server, so Claude Code, Cursor and other agents can check the app themselves
 * after a change. Over stdio by default; over HTTP with `--http` (see mcp-http.ts). Two tools:
 *
 *   check_app     zero setup, read-only: the URL and the key pages linked from it
 *   run_journeys  the journeys in journeys.config.ts (signup, login, checkout…)
 *
 * Both return the same REPORT.md the CLI writes. stdout carries only protocol messages; logs go to stderr.
 * Nothing is sent anywhere except to the URL being checked.
 *
 * Hosted mode (`--http --hosted`, for cloud builders like Lovable, Bolt and Replit that can't run npx on your
 * machine) only offers check_app, only for public URLs, and blocks every request to a private network.
 */

export interface McpOptions {
  /** Serving strangers over the internet: check_app only, public URLs only, private networks blocked. */
  hosted?: boolean;
}

const OUT_DIR = "verify-report";

const CHECK_APP = {
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
    annotations: { title: "Check the app in a real browser", readOnlyHint: true, openWorldHint: true },
} as const;

const RUN_JOURNEYS = {
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
    annotations: { title: "Run the app's user journeys", readOnlyHint: false, openWorldHint: true },
} as const;

const HOSTED_CHECK_APP = {
  ...CHECK_APP,
  description:
    CHECK_APP.description +
    " This server runs in the cloud: pass the app's public URL (its deployed or preview address, e.g. https://my-app.lovable.app), not localhost.",
  inputSchema: {
    ...CHECK_APP.inputSchema,
    properties: { url: { type: "string", description: "The app's public URL, e.g. https://my-app.lovable.app or https://my-app.vercel.app" } },
  },
};

export function toolsFor(options: McpOptions) {
  return options.hosted ? [HOSTED_CHECK_APP] : [CHECK_APP, RUN_JOURNEYS];
}

export interface Request {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

function send(message: unknown) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

export function version(): string {
  return JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version;
}

async function reachable(url: string, hosted = false) {
  try {
    await fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new UsageError(hosted ? `Couldn't reach ${url}. Is it deployed and public?` : `Couldn't reach ${url}. Is the app running? Start it, or pass the deployed URL.`);
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

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** The screenshots of failed pages, at most `max`: the hosted server deletes its files, so the agent gets the pictures. */
function failureShots(result: RunResult, max = 3): Content[] {
  const shots: Content[] = [];
  for (const journey of result.journeys) {
    if (journey.status !== "failed" || shots.length >= max) continue;
    const shot = [...journey.steps].reverse().find((s) => s.screenshot)?.screenshot;
    if (!shot) continue;
    try {
      shots.push({ type: "image", data: readFileSync(shot).toString("base64"), mimeType: "image/png" });
    } catch {
      // no screenshot on disk: the text report still says what failed
    }
  }
  return shots;
}

async function checkApp(args: Record<string, unknown>, options: McpOptions): Promise<Content[]> {
  if (typeof args.url !== "string" || !args.url.trim()) throw new UsageError("Pass the app's URL, e.g. http://localhost:3000.");
  const url = resolveBaseURL(args.url, {});
  const hosted = Boolean(options.hosted);
  if (hosted) await assertPublicURL(url);
  await reachable(url, hosted);
  const { finalURL, links } = await discover(url, { blockPrivateNetwork: hosted });
  // a redirect can point somewhere else: the page we ended on must be public too
  if (hosted) await assertPublicURL(finalURL.href);
  const startPath = `${finalURL.pathname}${finalURL.search}` || "/";
  const config = smokeConfig(startPath, pickPages(links, finalURL, MAX_EXTRA_PAGES));
  // hosted: every call gets its own folder, removed afterwards (nothing from one app is kept, or seen by the next)
  const outDir = hosted ? mkdtempSync(join(tmpdir(), "stillworks-")) : OUT_DIR;
  try {
    const result = await runJourneys(config, { baseURL: finalURL.origin, outDir, blockPrivateNetwork: hosted });
    const paths = writeReport(result, outDir, { rerun: `the check_app tool with url ${url}`, badge: false });
    let report = readFileSync(paths.markdown, "utf8");
    if (!hosted) return [{ type: "text", text: `${summary(result, "page")}\n\n${report}` }];
    // the files are about to be deleted: the screenshots travel as images instead of paths
    report = report.replace(/^Screenshot: .*\n?/gm, "");
    return [{ type: "text", text: `${summary(result, "page")} Screenshots of the failed pages are attached.\n\n${report}` }, ...failureShots(result)];
  } finally {
    if (hosted) rmSync(outDir, { recursive: true, force: true });
  }
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

const INSTRUCTIONS = {
  local: "After changing a web app, call check_app (or run_journeys if the project has journeys.config.ts) before saying the work is done, and fix what the report says.",
  hosted: "After changing a web app and publishing it, call check_app with its public URL before saying the work is done, and fix what the report says.",
};

/**
 * One JSON-RPC message in, its response out (undefined for notifications). Shared by the stdio and HTTP
 * transports, so both speak exactly the same protocol.
 */
export async function handleMessage(request: Request, options: McpOptions = {}): Promise<unknown | undefined> {
  const { id, method, params = {} } = request;
  const hasId = id !== undefined && id !== null;
  const reply = (result: unknown) => (hasId ? { jsonrpc: "2.0", id, result } : undefined);
  const fail = (code: number, message: string) => (hasId ? { jsonrpc: "2.0", id, error: { code, message } } : undefined);

  if (typeof method !== "string") return fail(-32600, "Invalid request");
  switch (method) {
    case "initialize":
      return reply({
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "stillworks", title: "stillworks", version: version() },
        instructions: options.hosted ? INSTRUCTIONS.hosted : INSTRUCTIONS.local,
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: toolsFor(options) });
    case "tools/call": {
      const name = params.name;
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const known = toolsFor(options).some((tool) => tool.name === name);
      if (!known) return fail(-32602, `Unknown tool: ${String(name)}`);
      try {
        const content = name === "check_app" ? await checkApp(args, options) : [{ type: "text", text: await runConfigured(args) }];
        return reply({ content });
      } catch (error) {
        // a setup problem (app not running, no config) is a tool error the agent can act on, not a protocol error
        return reply({ content: [{ type: "text", text: `stillworks: ${(error as Error).message}` }], isError: true });
      }
    }
    default:
      if (method.startsWith("notifications/")) return undefined;
      return fail(-32601, `Method not found: ${method}`);
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
    queue = queue
      .then(async () => {
        const response = await handleMessage(request);
        if (response) send(response);
      })
      .catch((error) => console.error("stillworks mcp:", error));
  }
  await queue;
  return 0;
}
