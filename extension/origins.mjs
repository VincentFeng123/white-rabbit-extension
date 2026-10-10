// The sites the extension talks to, for build.mjs: White Rabbit's production
// site, the Vercel deployment being built (VERCEL_PROJECT_PRODUCTION_URL,
// VERCEL_URL), and anything in WHITE_RABBIT_APP_URL (comma-separated). Local
// dev servers only in a development build (`--dev`, or
// WHITE_RABBIT_EXTENSION_DEV=1): any page on those ports, another project's
// dev server included, could otherwise ask a store build for a week of
// history. Tested in src/lib/server/extension-origins.test.ts.

// The apex, whiterabbt.com, 308s here and never serves a page, so it isn't listed.
export const PRODUCTION_URL = "https://www.whiterabbt.com";
/** `pnpm dev` and the preview config. */
export const LOCAL_DEV = ["http://localhost:3100", "http://localhost:3000"];

/**
 * A development build: `node extension/build.mjs --dev`, or WHITE_RABBIT_EXTENSION_DEV=1.
 * @param {readonly string[]} [argv]
 * @param {Record<string, string | undefined>} [env]
 */
export function isDevBuild(argv = process.argv, env = process.env) {
  return argv.includes("--dev") || env.WHITE_RABBIT_EXTENSION_DEV === "1";
}

/**
 * Each origin once, the first listed first (the popup's Open White Rabbit goes there).
 * @param {Record<string, string | undefined>} [env]
 * @param {boolean} [dev]
 * @returns {string[]}
 */
export function appOrigins(env = process.env, dev = isDevBuild(process.argv, env)) {
  /** @param {string | undefined} host */
  const withScheme = (host) => (host ? [`https://${host}`] : []);
  return [
    ...(env.WHITE_RABBIT_APP_URL ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    ...withScheme(env.VERCEL_PROJECT_PRODUCTION_URL),
    PRODUCTION_URL,
    ...withScheme(env.VERCEL_URL),
    ...(dev ? LOCAL_DEV : []),
  ]
    .map((u) => new URL(u).origin)
    .filter((o, i, all) => all.indexOf(o) === i);
}
