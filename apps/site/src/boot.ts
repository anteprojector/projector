// Boot: the only JS the marketing page pays for beyond its inline scripts.
// Owns the handoff from static page to conversation: warm the app chunk the
// moment the visitor shows intent, then morph the hero composer into the
// conversation composer on submit. The React app is never imported unless
// intent happens, so the landing stays static-page fast.

type AppModule = typeof import("./app/main");

const root = document.documentElement;
const page = document.querySelector<HTMLElement>(".page")!;
const talk = document.querySelector<HTMLFormElement>("#talk")!;
const talkCard = talk.querySelector<HTMLElement>(".talk-card")!;
const talkInput = talk.querySelector<HTMLInputElement>(".talk-input")!;
const talkClear = talk.querySelector<HTMLButtonElement>(".talk-clear")!;

let appPromise: Promise<AppModule> | null = null;

const loadApp = () => {
  if (!appPromise) {
    appPromise = import("./app/main").then((mod) => {
      mod.warm();
      return mod;
    });
  }
  return appPromise;
};

// A view transition when the browser has them and the visitor hasn't asked
// for stillness; a plain cut otherwise. The morph itself is declared in CSS
// via view-transition-name on the two composer cards.
const still = matchMedia("(prefers-reduced-motion: reduce)");
const withTransition = (mutate: () => void) => {
  if (!still.matches && document.startViewTransition) {
    return document.startViewTransition(mutate).finished.catch(() => {});
  }
  mutate();
  return Promise.resolve();
};

const enterApp = (mod: AppModule, opts: { initialMessage?: string; sessionId?: string }) => {
  root.classList.add("launching");
  return withTransition(() => {
    root.dataset.app = "1";
    page.inert = true;
    // Mounts synchronously (flushSync inside) so the view transition's new
    // snapshot already contains the conversation with the composer in place.
    mod.launch(opts);
  }).then(() => root.classList.remove("launching"));
};

const exitApp = async () => {
  const mod = await loadApp();
  await withTransition(() => {
    delete root.dataset.app;
    page.inert = false;
    mod.unmount();
  });
};

// Intent warms the chunk: hovering near the composer, focusing it, or even
// touching the page at all after a beat. By the time enter is pressed the
// module and the Convex socket should both be up.
talk.addEventListener("pointerenter", loadApp, { once: true });
talkInput.addEventListener("focus", loadApp, { once: true });
addEventListener("pointerdown", loadApp, { once: true });
setTimeout(loadApp, 8000);

talk.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = talkInput.value.trim() || talkInput.placeholder.trim();
  if (!text) return;
  retireResting();
  talkCard.classList.add("talk-waiting");
  try {
    const mod = await loadApp();
    history.pushState({ app: true }, "", "/s/new");
    await enterApp(mod, { initialMessage: text });
  } finally {
    talkCard.classList.remove("talk-waiting");
    talkInput.value = "";
  }
});

// Headline hot words leave a suggested value in the composer. It persists
// until another target suggests something or the visitor starts editing.
const previewAsk = (ask: string) => {
  talkInput.placeholder = ask;
  talkInput.toggleAttribute("data-suggested", true);
};
const commitPreview = () => {
  talkInput.removeAttribute("data-suggested");
  talkInput.placeholder = "hi";
};
const hotWords = [...document.querySelectorAll<HTMLButtonElement>(".hero h1 .hot")];
const explainers = [...document.querySelectorAll<HTMLElement>("[data-explainer]")];
const showExplainer = (topic: string | undefined) => {
  for (const explainer of explainers) {
    const active = explainer.dataset.explainer === topic;
    explainer.toggleAttribute("data-active", active);
    explainer.setAttribute("aria-hidden", String(!active));
  }
};
const activateHotWord = (hot: HTMLButtonElement) => {
  retireResting();
  for (const word of hotWords) {
    const active = word === hot;
    word.toggleAttribute("data-active", active);
    word.setAttribute("aria-pressed", String(active));
  }
  showExplainer(hot.dataset.topic);
};

// Resting cards: while nothing is engaged, the band below the composer slowly
// cycles through a few things worth asking. First real intent — a hot word,
// typing — retires the cycle for good; hovering the band pauses it.
const restTopics = explainers
  .map((el) => el.dataset.explainer ?? "")
  .filter((topic) => topic.startsWith("rest-"));
let restIndex = 0;
let restTimer: ReturnType<typeof setInterval> | undefined;
let resting = restTopics.length > 0 && !root.dataset.app;
const restAdvance = () => {
  showExplainer(restTopics[restIndex % restTopics.length]);
  restIndex += 1;
};
const restResume = () => {
  if (resting && restTimer === undefined) restTimer = setInterval(restAdvance, 7000);
};
const restPause = () => {
  clearInterval(restTimer);
  restTimer = undefined;
};
const retireResting = (clear = false) => {
  if (!resting) return;
  resting = false;
  restPause();
  // Later changes are visitor-driven, so announcing them is wanted again.
  document.querySelector(".talk-explainers")?.setAttribute("aria-live", "polite");
  if (clear) showExplainer(undefined);
};
if (resting) {
  if (still.matches) restAdvance(); // one static card, no motion
  else {
    setTimeout(() => {
      if (!resting) return;
      restAdvance();
      restResume();
    }, 1200);
    const band = document.querySelector<HTMLElement>(".talk-explainers");
    band?.addEventListener("pointerenter", restPause);
    band?.addEventListener("pointerleave", restResume);
  }
}
talkInput.addEventListener("input", () => {
  commitPreview();
  retireResting(true); // typing means engaged — fade the suggestion out of the way
});
talkInput.addEventListener("beforeinput", () => {
  if (talkInput.hasAttribute("data-suggested")) {
    commitPreview();
  }
});
talkClear.addEventListener("click", () => {
  commitPreview();
  talkInput.value = "";
  talkInput.focus({ preventScroll: true });
  talkInput.dispatchEvent(new Event("input", { bubbles: true }));
});
for (const hot of hotWords) {
  const ask = hot.dataset.ask ?? "";
  hot.addEventListener("pointerenter", (e) => {
    loadApp();
    if (e.pointerType !== "mouse") return;
    activateHotWord(hot);
    previewAsk(ask);
  });
  hot.addEventListener("focus", () => activateHotWord(hot));
  hot.addEventListener("click", () => {
    activateHotWord(hot);
    commitPreview();
    talkInput.value = ask;
    talk.requestSubmit();
  });
}

for (const prompt of document.querySelectorAll<HTMLButtonElement>("[data-prompt]")) {
  const ask = prompt.dataset.prompt ?? "";
  prompt.addEventListener("pointerenter", (e) => {
    if (e.pointerType !== "mouse") return;
    previewAsk(ask);
  });
  prompt.addEventListener("click", () => {
    commitPreview();
    talkInput.value = ask;
    talk.requestSubmit();
  });
}

// Look ready without stealing focus. The first printable key pressed anywhere
// on the marketing page is moved into the composer.
addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement | null;
  const editing = target?.matches("input, textarea, select, [contenteditable]");
  if (root.dataset.app || editing || e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return;
  e.preventDefault();
  talkInput.focus({ preventScroll: true });
  if (talkInput.hasAttribute("data-suggested")) {
    commitPreview();
  }
  const start = talkInput.selectionStart ?? talkInput.value.length;
  const end = talkInput.selectionEnd ?? talkInput.value.length;
  talkInput.setRangeText(e.key, start, end, "end");
  talkInput.dispatchEvent(new Event("input", { bubbles: true }));
});

// Deep link (/s/:id): the head script already hid the marketing page before
// paint; go straight into the conversation.
if (root.dataset.app) {
  const sessionId = location.pathname.split("/")[2];
  loadApp().then((mod) => {
    page.inert = true;
    mod.launch({ sessionId: sessionId === "new" ? undefined : sessionId });
  });
}

// Back returns to the marketing page; forward re-enters the conversation.
addEventListener("popstate", () => {
  const inApp = /^\/s\//.test(location.pathname);
  if (inApp && !root.dataset.app) {
    const sessionId = location.pathname.split("/")[2];
    loadApp().then((mod) => enterApp(mod, { sessionId: sessionId === "new" ? undefined : sessionId }));
  } else if (!inApp && root.dataset.app) {
    void exitApp();
  }
});
