/**
 * "Start with the past two days?", in a small window the background script
 * opens when the person turns on Rabbit in White Rabbit (askForHistory).
 * Adding the extension never asks for the browser's history; this does, and
 * only from a click here, because browsers ask for a permission only from
 * the extension's own page. With it, Rabbit's first look can read browsing
 * from before the extension was added: the past two days of it, as the
 * window's fine print says (later looks read on from where the last one
 * stopped). White Rabbit only ever reads it.
 */

import { ext, TARGET } from "./shared";

const root = document.getElementById("root")!;
const allow = document.getElementById("allow") as HTMLButtonElement;
const skip = document.getElementById("skip") as HTMLButtonElement;

// The browser's own words, so its question that follows isn't a surprise.
document.getElementById("warning")!.textContent =
  TARGET === "firefox"
    ? "Firefox will ask to let White Rabbit “Access browsing history.” It only reads it, and never changes or deletes anything."
    : "Your browser will say White Rabbit can “Read and change your browsing history on all your signed-in devices.” It only reads it, and never changes or deletes anything.";

async function close() {
  const tab = await ext.tabs.getCurrent().catch(() => null);
  if (tab?.id !== undefined) await ext.tabs.remove(tab.id).catch(() => window.close());
  else window.close();
}

function done(message: string) {
  const p = document.createElement("p");
  p.textContent = message;
  root.replaceChildren(p);
  window.setTimeout(close, 1600);
}

allow.onclick = () => {
  // Straight from the click, with nothing awaited first: browsers only ask during one.
  ext.permissions.request({ permissions: ["history"] }).then(
    (granted: boolean) =>
      done(
        granted
          ? "Done. Rabbit will start with the past two days."
          : "Okay. Rabbit will start with what you browse from now on.",
      ),
    () => done("Your browser didn't ask. Rabbit will start with what you browse from now on."),
  );
};

skip.onclick = () => void close();
