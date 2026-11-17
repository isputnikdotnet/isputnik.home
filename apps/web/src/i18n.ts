import i18n, { type BackendModule, type ReadCallback } from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en";
import type enControlPanel from "./locales/en/control-panel";

// The app's interface languages. English is the source of truth: every key is
// authored in locales/en first, other languages mirror it (scripts/
// check-ui-conventions.mjs fails the build when the key sets drift), and a
// missing translation falls back to the English string rather than breaking.
export const LANGUAGES = ["en", "ru"] as const;
export type Language = (typeof LANGUAGES)[number];

// Typed keys: t("profile.heading") compiles, t("profile.headnig") does not.
// Namespaced keys use a colon — t("gallery:timeline.empty").
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    // Every namespace, the control panel's included, though those load later.
    resources: typeof en & typeof enControlPanel;
    returnNull: false;
  }
}

// Mirrors the signed-in user's `language` preference so the sign-in screen and
// the offline PWA speak the right language before a session exists — the same
// idea as the cached default theme in app/App.tsx.
const STORAGE_KEY = "isputnik-language";

function isLanguage(value: unknown): value is Language {
  return LANGUAGES.includes(value as Language);
}

/** The language to boot in: the last one applied on this device, else the
 *  browser's own (first visit only) — a Russian-locale browser gets a Russian
 *  sign-in screen before anyone has an account to store a preference on. */
export function storedLanguage(): Language {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isLanguage(saved)) return saved;
  } catch {
    /* private mode */
  }
  return navigator.language?.toLowerCase().startsWith("ru") ? "ru" : "en";
}

// English ships in the main bundle (it is the fallback, so it must always be
// present); other languages load on demand so English users never download
// them. Each entry is one language's barrel — a single chunk with every
// namespace, added bundle by bundle below.
const BUNDLE_LOADERS: Record<Exclude<Language, "en">, () => Promise<{ default: Record<string, object> }>> = {
  ru: () => import("./locales/ru")
};

const loaded = new Set<Language>(["en"]);

// ── The control panel's strings, on demand ──────────────────────────────────
// `control`, `controlAdmin` and `controlDash` are about half of every
// language's strings (67 KB of English, compressed) and only the control panel
// and a few admin dialogs use them, so they are not in the barrels above: each
// language keeps them in its own control-panel.ts, one chunk.
//
// i18next fetches them through the small backend below the first time a
// component asks for one (useTranslation("controlAdmin"), …). react-i18next
// suspends that component meanwhile, so it shows its Suspense fallback — the
// page's, or a closer one — rather than raw keys. One request loads all three, so
// a component that reads "controlAdmin:…" while asking only for "control" still
// finds them. English always comes too: it is the fallback for a missing string.
export const CONTROL_NAMESPACES = ["control", "controlAdmin", "controlDash"] as const;

const CONTROL_LOADERS: Record<Language, () => Promise<{ default: Record<string, object> }>> = {
  en: () => import("./locales/en/control-panel"),
  ru: () => import("./locales/ru/control-panel")
};

const controlLoads = new Map<Language, Promise<void>>();

function loadControlStringsFor(language: Language): Promise<void> {
  let load = controlLoads.get(language);
  if (!load) {
    load = CONTROL_LOADERS[language]().then((bundle) => {
      for (const [ns, resources] of Object.entries(bundle.default)) {
        i18n.addResourceBundle(language, ns, resources, true, true);
      }
    });
    // A failed chunk (offline, a release replaced it) may be asked for again.
    load.catch(() => controlLoads.delete(language));
    controlLoads.set(language, load);
  }
  return load;
}

/** Load the control panel's strings for `language` (and English, the fallback).
 *  Components need not call this — asking for the namespace is enough; the test
 *  setup does, so control components render without suspending. */
export function loadControlStrings(language: string = i18n.language): Promise<void> {
  const lang = isLanguage(language) ? language : "en";
  return Promise.all([loadControlStringsFor("en"), lang === "en" ? null : loadControlStringsFor(lang)]).then(() => undefined);
}

const isControlNamespace = (ns: string): boolean => (CONTROL_NAMESPACES as readonly string[]).includes(ns);

/** i18next's on-demand loader. Only the control namespaces are ever missing: the
 *  rest is bundled, or added by setAppLanguage before the language switches. */
const controlPanelBackend: BackendModule = {
  type: "backend",
  init() {},
  read(language: string, namespace: string, callback: ReadCallback) {
    if (!isControlNamespace(namespace)) {
      callback(null, i18n.getResourceBundle(language, namespace) ?? {});
      return;
    }
    const lang = isLanguage(language) ? language : "en";
    loadControlStrings(lang).then(
      () => callback(null, i18n.getResourceBundle(lang, namespace) ?? {}),
      (err: unknown) => callback(err instanceof Error ? err : new Error(String(err)), false)
    );
  }
};

/** Switch the app to `language`: persist it for the next boot, lazy-load its
 *  strings, and re-render everything under a useTranslation hook. */
export async function setAppLanguage(language: Language): Promise<void> {
  try {
    localStorage.setItem(STORAGE_KEY, language);
  } catch {
    /* private mode */
  }
  if (!loaded.has(language)) {
    const bundle = await BUNDLE_LOADERS[language as Exclude<Language, "en">]();
    for (const [ns, resources] of Object.entries(bundle.default)) {
      i18n.addResourceBundle(language, ns, resources);
    }
    loaded.add(language);
  }
  await i18n.changeLanguage(language);
}

i18n.on("languageChanged", (lng) => {
  document.documentElement.lang = lng;
});

/** Resolves once the boot language's strings are in memory; main.tsx renders
 *  after this so a Russian device never flashes an English frame. */
export const i18nReady: Promise<void> = i18n
  .use(initReactI18next)
  .use(controlPanelBackend)
  .init({
    lng: "en",
    fallbackLng: "en",
    defaultNS: "common",
    ns: Object.keys(en),
    // A copy: i18next adds the namespaces it loads later into the object it is
    // given, and the imported barrel should stay what it says it is.
    resources: { en: { ...en } },
    // English is bundled except the control panel's namespaces, which the backend
    // above fetches when they are first asked for.
    partialBundledLanguages: true,
    // React already escapes interpolated values; double-escaping shows &#39;.
    interpolation: { escapeValue: false },
    returnNull: false
  })
  .then(() => setAppLanguage(storedLanguage()))
  .catch(() => {
    /* a failed ru chunk load leaves the app in English rather than blank */
  });

export default i18n;
