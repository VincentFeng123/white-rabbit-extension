// Builds the White Rabbit extension for every browser it supports:
//
//   extension/dist/chrome   Chrome, Edge, Brave, Opera, Vivaldi, Arc (Chromium, MV3 service worker)
//   extension/dist/firefox  Firefox 121+ (MV3 event page, data-collection declaration)
//   extension/dist/safari   Safari 16.4+, via `xcrun safari-web-extension-converter`
//
// plus a zip of each for store upload, and copies of the Chromium and Firefox
// zips in public/extension/ so the site can hand them out. `pnpm build` runs
// this first. The detection and capture code is compiled from the web app's
// own source (src/lib/capture), so the extension and the app always agree.
//
// The extension talks only to White Rabbit's own sites: the production site,
// the Vercel deployment being built (VERCEL_PROJECT_PRODUCTION_URL,
// VERCEL_URL), and anything in WHITE_RABBIT_APP_URL (comma-separated). Local
// dev servers (localhost:3000 and :3100) only in a development build, `--dev`
// or WHITE_RABBIT_EXTENSION_DEV=1 (see origins.mjs). Each build's manifest
// comes from manifest.mjs.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { zipSync } from "fflate";
import { manifest } from "./manifest.mjs";
import { appOrigins, isDevBuild } from "./origins.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dist = join(here, "dist");
const publicDir = join(root, "public", "extension");
const VERSION = "0.5.1";

const DEV = isDevBuild();
const origins = appOrigins(process.env, DEV);

// Type-check first; esbuild only strips types.
execFileSync(join(root, "node_modules", ".bin", "tsc"), ["-p", join(here, "tsconfig.json")], { stdio: "inherit" });

/**
 * Every file under `dir`, keyed by its path inside it (for zipping), in name
 * order, so the same files always make the same zip.
 */
function filesUnder(dir) {
  const out = {};
  const walk = (d) => {
    const entries = readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p);
    }
  };
  walk(dir);
  return out;
}

rmSync(dist, { recursive: true, force: true });
rmSync(publicDir, { recursive: true, force: true });
mkdirSync(publicDir, { recursive: true });
for (const target of ["chrome", "firefox", "safari"]) {
  const out = join(dist, target);
  mkdirSync(out, { recursive: true });
  await build({
    entryPoints: {
      background: join(here, "src/background.ts"),
      popup: join(here, "src/popup.ts"),
      bridge: join(here, "src/bridge.ts"),
      grant: join(here, "src/grant.ts"),
    },
    outdir: join(out, "js"),
    bundle: true,
    format: "iife",
    target: ["chrome116", "firefox121", "safari16"],
    define: {
      __APP_ORIGINS__: JSON.stringify(origins),
      __TARGET__: JSON.stringify(target),
      __VERSION__: JSON.stringify(VERSION),
    },
    logLevel: "warning",
  });
  cpSync(join(here, "popup.html"), join(out, "popup.html"));
  cpSync(join(here, "grant.html"), join(out, "grant.html"));
  cpSync(join(here, "popup.css"), join(out, "popup.css"));
  cpSync(join(here, "icons"), join(out, "icons"), { recursive: true });
  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest(target, origins, VERSION), null, 2)}\n`);
  // A fixed date on every entry (zips store local time), so anyone building
  // the same source gets the same zip, byte for byte, as the one in the store.
  const zip = zipSync(filesUnder(out), { level: 9, mtime: new Date(2026, 0, 1) });
  writeFileSync(join(dist, `white-rabbit-${target}.zip`), zip);
  // Safari needs Xcode to package, so only these two are offered for download.
  if (target !== "safari") writeFileSync(join(publicDir, `white-rabbit-${target}.zip`), zip);
}

console.log(`Built extension/dist/{chrome,firefox,safari} (+ zips) for ${origins.join(", ")}`);
if (DEV) console.log("Development build: it trusts localhost too. Don't upload these zips to a store.");
else console.log("For local development, build with --dev so it also talks to localhost:3000 and :3100.");
console.log(
  "Chromium: load extension/dist/chrome unpacked. Firefox: load white-rabbit-firefox.zip in about:debugging.",
);
console.log("Safari: xcrun safari-web-extension-converter extension/dist/safari");
