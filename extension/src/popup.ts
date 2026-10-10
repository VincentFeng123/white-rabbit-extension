/**
 * The popup: whether White Rabbit is noticing, the current possible rabbit
 * hole, and pause controls. There's nothing to capture by hand: White Rabbit
 * reads from here by itself whenever it's open.
 */

import { APP_ORIGIN, ext, isPaused, type Message, type Settings, type SuggestionSummary } from "./shared";

function send<T>(msg: Message): Promise<T> {
  return ext.runtime.sendMessage(msg) as Promise<T>;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

async function render() {
  const root = document.getElementById("root")!;
  const { settings, suggestions } = await send<{ settings: Settings; suggestions: SuggestionSummary[] }>({
    type: "status",
  });
  root.replaceChildren();

  const header = el("header");
  header.append(el("strong", "", "White Rabbit"));
  const state = !settings.enabled ? "Off" : isPaused(settings) ? "Paused" : "Active";
  header.append(el("span", `status ${state.toLowerCase()}`, state));
  root.append(header);

  const intro = el("section", "capture");
  intro.append(
    el(
      "p",
      "muted",
      state === "Active"
        ? "Rabbit holes you go down show up on White Rabbit by themselves."
        : "Not noticing anything right now.",
    ),
  );
  const open = el("button", "primary", "Open White Rabbit") as HTMLButtonElement;
  open.onclick = async () => {
    await ext.tabs.create({ url: `${APP_ORIGIN}/` });
    window.close();
  };
  intro.append(open);
  root.append(intro);

  const current = suggestions[0];
  if (current) {
    const card = el("section", "card");
    card.append(el("p", "muted", "Possible rabbit hole"));
    card.append(el("h1", "", current.topic));
    card.append(el("p", "muted", `${current.pages} sources · ${current.minutes} min`));
    const review = el("button", "", "Review");
    review.onclick = async () => {
      await send({ type: "review", id: current.id });
      window.close();
    };
    const ignore = el("button", "", "Ignore");
    ignore.onclick = async () => {
      await send({ type: "ignore", id: current.id });
      render();
    };
    const actions = el("div", "row");
    actions.append(review, ignore);
    card.append(actions);
    root.append(card);
  }

  const footer = el("footer", "row");
  if (isPaused(settings)) {
    const resume = el("button", "", "Resume");
    resume.onclick = async () => {
      await send({ type: "resume" });
      render();
    };
    footer.append(resume);
  } else {
    const pause = el("select") as HTMLSelectElement;
    for (const [value, label] of [
      ["", "Pause…"],
      ["15", "15 minutes"],
      ["60", "1 hour"],
      ["tomorrow", "Until tomorrow"],
      ["indefinite", "Until I resume"],
    ]) {
      const o = el("option", "", label) as HTMLOptionElement;
      o.value = value;
      pause.append(o);
    }
    pause.onchange = async () => {
      const v = pause.value;
      if (!v) return;
      const until =
        v === "indefinite"
          ? ("indefinite" as const)
          : v === "tomorrow"
            ? new Date(new Date().setHours(32, 0, 0, 0)).getTime()
            : Date.now() + Number(v) * 60_000;
      await send({ type: "pause", until });
      render();
    };
    footer.append(pause);
  }
  const settingsLink = el("a", "link", "Settings") as HTMLAnchorElement;
  settingsLink.href = `${APP_ORIGIN}/settings/privacy`;
  settingsLink.target = "_blank";
  footer.append(settingsLink);
  root.append(footer);
  root.append(
    el(
      "p",
      "fine",
      "Your browsing is read only by White Rabbit tabs in this browser. If you turn on Rabbit there, White Rabbit sends what Settings → Capture & privacy lists to its AI provider once a day.",
    ),
  );
}

render();
