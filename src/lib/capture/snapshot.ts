/**
 * A capture: what someone chose to hand White Rabbit from their browser at
 * one moment. Every way in — the extension (Chrome, Edge, Brave, Firefox,
 * Safari…), an exported history file, the bookmarklet, the share sheet, or
 * pasted links — produces raw pages and tabs, and `buildSnapshot` turns
 * them into the same shape: pages, open tabs, searches, links followed, and
 * sites. Everything downstream (rabbit-hole detection, storage)
 * only ever sees a CaptureSnapshot.
 *
 * Exclusions (blocked sites, sensitive categories, sign-in pages, private
 * links, paused time) are applied here, and every address is cleaned of
 * fragments, tokens and other secret-looking parameters (./clean-url),
 * before anything is kept.
 *
 * Shared by the web app and the extension (which compiles this file), so
 * imports stay relative and app-free.
 */

import { cleanPage } from "./clean-url";
import { exclusionReason, type DetectEvent, type DetectRules } from "./detect";
import { parseSearch } from "./search-engines";

export const SNAPSHOT_VERSION = 1;

export type CaptureSource = "extension" | "history-file" | "bookmarklet" | "share" | "paste";

/** How White Rabbit Helper's captures (Safari on a Mac) are labelled; they're kept for a rolling week. */
export const HELPER_BROWSER = "Safari (White Rabbit Helper)";
export const HELPER_KEEP_MS = 7 * 24 * 3_600_000;

export interface CapturedTab {
  url: string;
  title: string;
  domain: string;
  active?: boolean;
  pinned?: boolean;
  /** Tabs in the same window share this. */
  windowId?: number;
  /** When the tab was last looked at, if the browser says. */
  lastAccessed?: string;
}

export interface CapturedSearch {
  query: string;
  engine: string;
  url: string;
  at: string;
}

/** A link followed: `to` was opened from `from`. */
export interface CapturedLink {
  from: string;
  to: string;
  fromTitle: string;
  toTitle: string;
  at: string;
}

export interface CapturedSite {
  domain: string;
  visits: number;
  /** Foreground reading time, when known. */
  minutes: number;
  firstAt: string;
  lastAt: string;
  /** A representative page title. */
  title: string;
}

export interface CaptureCounts {
  pages: number;
  tabs: number;
  searches: number;
  links: number;
  sites: number;
  /** Pages and tabs dropped by the person's rules, never stored. */
  excluded: number;
}

export interface CaptureSnapshot {
  version: typeof SNAPSHOT_VERSION;
  source: CaptureSource;
  /** "Chrome 140", "Firefox 144", "Safari 26". */
  browser: string;
  capturedAt: string;
  /** The window of history covered. */
  from: string;
  to: string;
  pages: DetectEvent[];
  tabs: CapturedTab[];
  searches: CapturedSearch[];
  links: CapturedLink[];
  sites: CapturedSite[];
  counts: CaptureCounts;
}

export const MAX_PAGES = 1500;
export const MAX_TABS = 300;

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

const isWeb = (url: string) => /^https?:\/\//i.test(url);

/** Links followed, from explicit referrers and tab openers, then same-tab navigation. */
function deriveLinks(pages: DetectEvent[]): CapturedLink[] {
  const out: CapturedLink[] = [];
  const seen = new Set<string>();
  const time = (e: DetectEvent) => new Date(e.at).getTime();
  const byUrl = new Map<string, DetectEvent>();
  const lastInTab = new Map<number, DetectEvent>();
  for (const e of pages) {
    let from: DetectEvent | undefined;
    if (e.referrer) from = byUrl.get(e.referrer);
    if (!from && e.openerTabId !== undefined && e.tabId >= 0 && !lastInTab.has(e.tabId)) {
      from = lastInTab.get(e.openerTabId);
    }
    if (!from && e.tabId >= 0 && e.transition === "link") {
      const prev = lastInTab.get(e.tabId);
      if (prev && time(e) - time(prev) < 30 * 60_000) from = prev;
    }
    if (from && from.url !== e.url) {
      const key = `${from.url}→${e.url}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ from: from.url, to: e.url, fromTitle: from.title, toTitle: e.title, at: e.at });
      }
    }
    byUrl.set(e.url, e);
    if (e.tabId >= 0) lastInTab.set(e.tabId, e);
  }
  return out;
}

function deriveSites(pages: DetectEvent[]): CapturedSite[] {
  const sites = new Map<string, CapturedSite>();
  for (const e of pages) {
    const s = sites.get(e.domain);
    if (!s) {
      sites.set(e.domain, {
        domain: e.domain,
        visits: 1,
        minutes: e.dwellSeconds / 60,
        firstAt: e.at,
        lastAt: e.at,
        title: e.title,
      });
    } else {
      s.visits += 1;
      s.minutes += e.dwellSeconds / 60;
      if (e.at < s.firstAt) s.firstAt = e.at;
      if (e.at > s.lastAt) s.lastAt = e.at;
    }
  }
  return [...sites.values()]
    .map((s) => ({ ...s, minutes: Math.round(s.minutes) }))
    .sort((a, b) => b.visits - a.visits || b.minutes - a.minutes);
}

function deriveSearches(pages: DetectEvent[], tabs: CapturedTab[], capturedAt: string): CapturedSearch[] {
  const out: CapturedSearch[] = [];
  const seen = new Set<string>();
  const add = (url: string, at: string) => {
    const hit = parseSearch(url);
    if (!hit) return;
    const key = `${hit.engine}:${hit.query.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ query: hit.query, engine: hit.engine, url, at });
  };
  for (const e of pages) add(e.url, e.at);
  for (const t of tabs) add(t.url, t.lastAccessed ?? capturedAt);
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** One visit to a page, as the browser's history API reports it (history.getVisits). */
export interface HistoryVisit {
  visitId: string;
  visitTime?: number;
  referringVisitId?: string;
  transition?: string;
  /** Chromium 115+: false when the visit was synced from another of the person's devices. Firefox doesn't say. */
  isLocal?: boolean;
}

/**
 * A history page's visits since `since` that were made in this browser. With
 * history sync on, Chromium's history also holds visits from the person's
 * phone and other computers; those stay out, and so does a page seen here
 * only on them. When the browser gives no visits for a page, its last visit
 * stands in.
 */
export function historyVisits(
  page: { id: string; lastVisitTime?: number; typedCount?: number },
  visits: HistoryVisit[],
  since: number,
): HistoryVisit[] {
  const list = visits.length
    ? visits.filter((v) => v.isLocal !== false)
    : [{ visitId: `i${page.id}`, visitTime: page.lastVisitTime, transition: page.typedCount ? "typed" : "link" }];
  return list.filter((v) => (v.visitTime ?? 0) >= since);
}

export interface SnapshotInput {
  source: CaptureSource;
  browser: string;
  pages: DetectEvent[];
  tabs?: CapturedTab[];
  rules: DetectRules;
  from?: string;
  to?: string;
  now?: number;
}

export function buildSnapshot(input: SnapshotInput): CaptureSnapshot {
  const now = input.now ?? Date.now();
  const capturedAt = new Date(now).toISOString();
  let excluded = 0;

  const byId = new Map<string, DetectEvent>();
  for (const p of input.pages) {
    if (!isWeb(p.url)) continue;
    const clean = cleanPage(p);
    if (!clean) {
      excluded += 1;
      continue;
    }
    const page: DetectEvent = {
      ...clean,
      domain: p.domain || domainOf(clean.url),
      title: (clean.title || clean.url).slice(0, 300),
    };
    // A page that looks like a search is a search, whatever the browser said.
    if (page.transition !== "reload" && parseSearch(page.url)) page.transition = "search";
    if (exclusionReason(page, input.rules) !== null) {
      excluded += 1;
      continue;
    }
    // The page it came from is kept only if it could have been kept itself.
    if (page.referrer && exclusionReason({ ...page, url: page.referrer, domain: domainOf(page.referrer) }, input.rules) !== null)
      delete page.referrer;
    byId.set(page.id, page);
  }
  const pages = [...byId.values()].sort((a, b) => a.at.localeCompare(b.at)).slice(-MAX_PAGES);

  const tabs: CapturedTab[] = [];
  const seenTabs = new Set<string>();
  for (const raw of input.tabs ?? []) {
    if (!isWeb(raw.url)) continue;
    const t = cleanPage(raw);
    if (!t) {
      excluded += 1;
      continue;
    }
    if (seenTabs.has(t.url)) continue;
    const domain = t.domain || domainOf(t.url);
    const probe: DetectEvent = {
      id: "tab",
      url: t.url,
      title: t.title,
      domain,
      at: t.lastAccessed ?? capturedAt,
      tabId: -1,
      transition: "link",
      dwellSeconds: 0,
    };
    if (exclusionReason(probe, input.rules) !== null) {
      excluded += 1;
      continue;
    }
    seenTabs.add(t.url);
    tabs.push({ ...t, domain, title: (t.title || t.url).slice(0, 300) });
    if (tabs.length >= MAX_TABS) break;
  }

  const searches = deriveSearches(pages, tabs, capturedAt);
  const links = deriveLinks(pages);
  const sites = deriveSites(pages);
  const from = input.from ?? pages[0]?.at ?? capturedAt;
  const to = input.to ?? capturedAt;

  return {
    version: SNAPSHOT_VERSION,
    source: input.source,
    browser: input.browser.slice(0, 80),
    capturedAt,
    from,
    to,
    pages,
    tabs,
    searches,
    links,
    sites,
    counts: {
      pages: pages.length,
      tabs: tabs.length,
      searches: searches.length,
      links: links.length,
      sites: sites.length,
      excluded,
    },
  };
}

/** "Chrome 140", "Edge 140", "Firefox 144", "Safari 26", from a user agent. */
export function browserName(ua: string, brands?: { brand: string; version: string }[]): string {
  const brand = brands?.find((b) => /Edge|Opera|Brave|Vivaldi|Arc|Chrome/i.test(b.brand) && !/Not/i.test(b.brand));
  const pick = (re: RegExp, name: string) => {
    const m = ua.match(re);
    return m ? `${name} ${m[1]}` : null;
  };
  return (
    pick(/Edg(?:e|A|iOS)?\/(\d+)/, "Edge") ??
    pick(/OPR\/(\d+)/, "Opera") ??
    pick(/Vivaldi\/(\d+)/, "Vivaldi") ??
    pick(/SamsungBrowser\/(\d+)/, "Samsung Internet") ??
    pick(/Firefox\/(\d+)/, "Firefox") ??
    pick(/FxiOS\/(\d+)/, "Firefox") ??
    pick(/CriOS\/(\d+)/, "Chrome") ??
    (brand && brand.brand !== "Google Chrome" && brand.brand !== "Chromium"
      ? `${brand.brand} ${brand.version}`
      : null) ??
    pick(/Chrome\/(\d+)/, "Chrome") ??
    pick(/Version\/(\d+(?:\.\d+)?).*Safari/, "Safari") ??
    "Browser"
  );
}
