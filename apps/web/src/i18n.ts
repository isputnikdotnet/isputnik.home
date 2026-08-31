import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en";

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
    resources: typeof en;
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
  .init({
    lng: "en",
    fallbackLng: "en",
    defaultNS: "common",
    ns: Object.keys(en),
    resources: { en },
    // React already escapes interpolated values; double-escaping shows &#39;.
    interpolation: { escapeValue: false },
    returnNull: false
  })
  .then(() => setAppLanguage(storedLanguage()))
  .catch(() => {
    /* a failed ru chunk load leaves the app in English rather than blank */
  });

export default i18n;
