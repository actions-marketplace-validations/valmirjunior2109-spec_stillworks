import type { Page } from "playwright";
import { UsageError } from "./config.js";
import type { Config, Journey, Step } from "./config.js";

/**
 * `stillworks check <url>`: a first check with zero setup. It opens the URL, finds the app's key pages
 * (signup, login, pricing, dashboard first), and turns each one into a read-only journey:
 *
 *   1. Open the page        the server must not answer with an error
 *   2. Show the page        not a "404 / not found" screen, not a blank page
 *   3. No JavaScript crash  no uncaught errors while the page loads
 *   4. No server errors     no 5xx from your own app (its pages and its API)
 *
 * It only opens pages: it never fills a form, clicks a button or follows links that look like they change
 * data (log out, delete…), so it's safe to point at any public URL. Real flows (signup, checkout) need
 * journeys: `npx stillworks init`.
 */

/** Pages checked besides the one you pass. */
export const MAX_EXTRA_PAGES = 6;

/** Links that could change something in the app: never opened. */
const UNSAFE_LINK = /log-?out|sign-?out|delete|remove|unsubscribe|cancel|destroy|reset/i;
/** The pages worth checking first. */
const KEY_LINK = /sign-?up|register|get-?started|start|log-?in|sign-?in|auth|pricing|plans?|dashboard|app|account|checkout|cart|contact|demo/i;

export interface FoundLink {
  path: string;
  text: string;
}

/**
 * The same-origin pages linked from the start page, key ones first, at most `max`. Pure, so it's testable:
 * `links` is what the page had (absolute hrefs and their text).
 */
export function pickPages(links: FoundLink[], start: URL, max = MAX_EXTRA_PAGES): string[] {
  const seen = new Set([pathOf(start)]);
  const picked: { path: string; key: boolean }[] = [];
  for (const link of links) {
    let url: URL;
    try {
      url = new URL(link.path, start);
    } catch {
      continue;
    }
    if (url.origin !== start.origin || (url.protocol !== "http:" && url.protocol !== "https:")) continue;
    const path = pathOf(url);
    if (seen.has(path) || UNSAFE_LINK.test(`${url.pathname} ${link.text}`)) continue;
    // files, not pages
    if (/\.(pdf|zip|png|jpe?g|gif|svg|webp|mp4|mp3|csv|xml|json|txt)$/i.test(url.pathname)) continue;
    seen.add(path);
    picked.push({ path, key: KEY_LINK.test(`${url.pathname} ${link.text}`) });
  }
  return picked
    .sort((a, b) => Number(b.key) - Number(a.key))
    .slice(0, max)
    .map((p) => p.path);
}

function pathOf(url: URL): string {
  return `${url.pathname}${url.search}` || "/";
}

/** Reads the links on the page you're on (anchors only; nothing is clicked). */
export async function readLinks(page: Page): Promise<FoundLink[]> {
  return page.$$eval("a[href]", (anchors) =>
    anchors.map((a) => ({ path: (a as HTMLAnchorElement).href, text: (a.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60) })),
  );
}

/**
 * "404", "not found" or a blank page. SPAs (Vite, React Router, Lovable and Bolt templates) answer 200 and draw
 * their "not found" screen with JavaScript, so the status code alone can't tell.
 */
export function looksLikeErrorScreen(title: string, heading: string, bodyText: string): string | undefined {
  const text = `${title} ${heading}`;
  if (/\b404\b|page not found|not found/i.test(text) || /^\s*404\b/.test(bodyText)) return `The page shows a "not found" screen ("${(heading || title).trim().slice(0, 80)}").`;
  if (bodyText.trim().length < 5) return "The page is blank: nothing was drawn on the screen.";
  return undefined;
}

/** A read-only journey for one page. Each journey keeps its own record of crashes and server errors. */
export function pageJourney(path: string, name: string): Journey {
  const crashes: string[] = [];
  const serverErrors: string[] = [];
  let origin = "";

  const steps: Step[] = [
    {
      name: `Open ${path}`,
      run: async ({ page, baseURL }) => {
        origin = new URL(baseURL).origin;
        page.on("pageerror", (error) => crashes.push(`${error.name}: ${error.message}`));
        page.on("response", (response) => {
          const status = response.status();
          let sameOrigin = false;
          try {
            sameOrigin = new URL(response.url()).origin === origin;
          } catch {
            // data: and blob: URLs
          }
          // the page itself is checked by this step; its status doesn't count twice
          if (status >= 500 && sameOrigin && !response.request().isNavigationRequest()) {
            serverErrors.push(`${response.request().method()} ${new URL(response.url()).pathname} → ${status}`);
          }
        });
        const response = await page.goto(path, { waitUntil: "load" });
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
        if (response && response.status() >= 400) throw new Error(`The server answered ${response.status()} ${response.statusText()} for ${path}.`);
      },
    },
    {
      name: "Show the page, not an error screen",
      run: async ({ page }) => {
        const facts = await page.evaluate(() => ({
          title: document.title,
          heading: document.querySelector("h1")?.textContent ?? "",
          body: document.body?.innerText ?? "",
        }));
        const problem = looksLikeErrorScreen(facts.title, facts.heading, facts.body);
        if (problem) throw new Error(problem);
      },
    },
    {
      name: "No JavaScript crash",
      run: () => {
        if (crashes.length) throw new Error(`The page crashed with ${crashes.length === 1 ? "an uncaught error" : `${crashes.length} uncaught errors`}: ${crashes.slice(0, 3).join(" | ")}`);
      },
    },
    {
      name: "No server errors from your app",
      run: () => {
        if (serverErrors.length) throw new Error(`Your app answered with a server error: ${serverErrors.slice(0, 3).join(" | ")}`);
      },
    },
  ];
  return { name, steps };
}

/** The config `check` runs: the start page, then each linked page. */
export function smokeConfig(startPath: string, extraPaths: string[], timeout?: number): Config {
  return {
    timeout,
    journeys: [pageJourney(startPath, startPath === "/" ? "home" : startPath), ...extraPaths.map((path) => pageJourney(path, path))],
  };
}

/**
 * Opens the start page once to read its links. Headers (like a preview bypass) go to your app's origin only.
 * Returns the final URL (after redirects) and the links it found.
 */
export async function discover(
  url: string,
  options: { channel?: string; headed?: boolean; headers?: Record<string, string>; timeout?: number },
): Promise<{ finalURL: URL; links: FoundLink[] }> {
  const { chromium } = await import("playwright");
  let browser;
  try {
    browser = await chromium.launch({ headless: !options.headed, channel: options.channel });
  } catch (error) {
    if (/Executable doesn't exist|playwright install/i.test(String((error as Error).message))) {
      throw new UsageError(options.channel ? `Couldn't start ${options.channel}. Is it installed?` : "The browser isn't installed yet. Run: npx stillworks install");
    }
    throw error;
  }
  try {
    const origin = new URL(url).origin;
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const headers = options.headers ?? {};
    if (Object.keys(headers).length) {
      await context.route("**/*", (route) => {
        const request = route.request();
        let same = false;
        try {
          same = new URL(request.url()).origin === origin;
        } catch {
          // data: and blob:
        }
        return same ? route.continue({ headers: { ...request.headers(), ...headers } }) : route.continue();
      });
    }
    const page = await context.newPage();
    await page.goto(url, { waitUntil: "load", timeout: (options.timeout ?? 10_000) * 3 }).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    const links = await readLinks(page).catch(() => []);
    return { finalURL: new URL(page.url() || url), links };
  } finally {
    await browser.close().catch(() => {});
  }
}
