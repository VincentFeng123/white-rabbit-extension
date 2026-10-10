/**
 * Recognizes a search from its URL, on the engines and sites people search
 * with: web search engines, AI answer engines, and the search boxes of big
 * sites (YouTube, Wikipedia, Reddit, GitHub, …).
 *
 * Shared verbatim by the web app and the browser extension (the extension
 * compiles this file), so keep it free of imports.
 */

export interface SearchHit {
  /** Display name: "Google", "YouTube". */
  engine: string;
  query: string;
}

interface Engine {
  name: string;
  host: RegExp;
  path?: RegExp;
  /** Query parameters to read, in order. */
  params: string[];
  /** For engines that put the query in the path (perplexity.ai/search/<slug>). */
  fromPath?: (path: string) => string | null;
}

const ENGINES: Engine[] = [
  { name: "Google Scholar", host: /(^|\.)scholar\.google\.[a-z.]+$/, params: ["q"] },
  { name: "Google", host: /(^|\.)google\.[a-z.]+$/, path: /^\/(search|webhp)?$/, params: ["q"] },
  { name: "Bing", host: /(^|\.)bing\.com$/, path: /^\/search/, params: ["q"] },
  { name: "DuckDuckGo", host: /(^|\.)duckduckgo\.com$/, params: ["q"] },
  { name: "Brave Search", host: /^search\.brave\.com$/, params: ["q"] },
  { name: "Kagi", host: /(^|\.)kagi\.com$/, path: /^\/search/, params: ["q"] },
  { name: "Ecosia", host: /(^|\.)ecosia\.org$/, path: /^\/search/, params: ["q"] },
  { name: "Startpage", host: /(^|\.)startpage\.com$/, params: ["query", "q"] },
  { name: "Yahoo", host: /(^|\.)search\.yahoo\.com$/, params: ["p", "q"] },
  { name: "Yandex", host: /(^|\.)yandex\.[a-z.]+$/, path: /^\/search/, params: ["text"] },
  { name: "Baidu", host: /(^|\.)baidu\.com$/, path: /^\/s$/, params: ["wd", "word"] },
  { name: "Qwant", host: /(^|\.)qwant\.com$/, params: ["q"] },
  {
    name: "Perplexity",
    host: /(^|\.)perplexity\.ai$/,
    params: ["q"],
    fromPath: (p) => {
      const m = p.match(/^\/search\/([^/?#]+)/);
      // Slugs end in a short id: "why-is-fusion-hard-Ab3dE.x9".
      return m
        ? decodeURIComponent(m[1])
            .replace(/-[A-Za-z0-9_.]{6,}$/, "")
            .replace(/-/g, " ")
        : null;
    },
  },
  { name: "ChatGPT", host: /(^|\.)chatgpt\.com$/, params: ["q"] },
  { name: "YouTube", host: /(^|\.)youtube\.com$/, path: /^\/results/, params: ["search_query", "q"] },
  { name: "Wikipedia", host: /(^|\.)wikipedia\.org$/, params: ["search"] },
  { name: "Reddit", host: /(^|\.)reddit\.com$/, path: /\/search\/?$/, params: ["q"] },
  { name: "GitHub", host: /^github\.com$/, path: /^\/search/, params: ["q"] },
  { name: "Stack Overflow", host: /(^|\.)stackoverflow\.com$/, path: /^\/search/, params: ["q"] },
  { name: "Hacker News", host: /^hn\.algolia\.com$/, params: ["query", "q"] },
  { name: "X", host: /(^|\.)(x|twitter)\.com$/, path: /^\/search/, params: ["q"] },
  { name: "Amazon", host: /(^|\.)amazon\.[a-z.]+$/, path: /^\/s$/, params: ["k"] },
  {
    name: "Spotify",
    host: /^open\.spotify\.com$/,
    fromPath: (p) => p.match(/^\/search\/(.+)$/)?.[1] ?? null,
    params: [],
  },
];

/** The engine a URL searches with, and its query, or null for any other page. */
function match(u: URL): { engine: Engine; query: string } | null {
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  for (const e of ENGINES) {
    if (!e.host.test(host)) continue;
    if (e.path && !e.path.test(u.pathname)) continue;
    let query: string | null = null;
    for (const p of e.params) {
      query = u.searchParams.get(p);
      if (query) break;
    }
    if (!query && e.fromPath) {
      try {
        query = e.fromPath(decodeURIComponent(u.pathname));
      } catch {
        query = e.fromPath(u.pathname);
      }
    }
    const clean = query?.replace(/\s+/g, " ").trim();
    if (clean) return { engine: e, query: clean.slice(0, 300) };
  }
  return null;
}

/** The search a URL represents, or null for any other page. */
export function parseSearch(url: string): SearchHit | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const hit = match(u);
  return hit ? { engine: hit.engine.name, query: hit.query } : null;
}

/** The parameters a search keeps its query in ("q"), or null when the URL isn't a search. */
export function searchQueryParams(u: URL): string[] | null {
  return match(u)?.engine.params ?? null;
}
