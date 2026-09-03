/**
 * The interface's language.
 *
 * Separate from `app.locale`, which picks the *database* overlay, because they are
 * genuinely different choices: the overlay has French (as authored) and English, and
 * the database is 541,061 requests nobody is going to translate. Somebody reading
 * Polish buttons over a French database is a normal state, so the two are two controls.
 *
 * i18next does the actual work — interpolation, and plural category selection through
 * `Intl.PluralRules`, which matters because Polish has four forms and their boundaries
 * are not where an English speaker would put them (22 takes the same form as 2). The
 * catalogues are plain JSON so they can be translated without touching code.
 *
 * What is *not* i18next's is choosing the language. `i18next-browser-languagedetector`
 * caches what it detected as though the user had chosen it, which breaks a "match my
 * browser" setting — that setting has to keep following the browser afterwards. So the
 * preference is stored and resolved on every load instead.
 */

import { negotiateLocale } from "@ddtx/i18n";
import i18next, { type ParseKeys } from "i18next";
import en from "../i18n/locales/en.json";
import pl from "../i18n/locales/pl.json";

/** Every interface locale, labelled in its own language. */
export const UI_LOCALES = [
  { tag: "en", label: "English" },
  { tag: "pl", label: "Polski" },
] as const;

const KEY = "ddtx.uiLocale";
const TAGS = UI_LOCALES.map((l) => l.tag);

/** `"system"`, or one of `UI_LOCALES`. */
export type UiPreference = "system" | (string & {});

function readPreference(): UiPreference {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "system") return "system";
    if (stored !== null && TAGS.includes(stored as (typeof TAGS)[number])) return stored;
  } catch {
    // Storage can be denied outright; the default is fine.
  }
  return "system";
}

/** What the browser asks for, narrowed to something we have. */
export function detectLocale(): string {
  const preferred =
    typeof navigator === "undefined"
      ? []
      : ((navigator.languages as readonly string[] | undefined) ??
        [navigator.language].filter(Boolean));
  return negotiateLocale(preferred, TAGS, "en");
}

function resolve(preference: UiPreference): string {
  return preference === "system" ? detectLocale() : preference;
}

const state = $state({ preference: readPreference(), resolved: "en" });

state.resolved = resolve(state.preference);

void i18next.init({
  lng: state.resolved,
  // English is the source catalogue, so a key missing from another locale falls back to
  // real text rather than to its own id.
  fallbackLng: "en",
  supportedLngs: TAGS,
  defaultNS: "app",
  resources: { en: { app: en }, pl: { app: pl } },
  interpolation: {
    // Svelte escapes on output already, and these strings are ours rather than user
    // input. Leaving it on double-escapes the curly quotes and the middot.
    escapeValue: false,
  },
});

applyLang();

function applyLang(): void {
  if (typeof document !== "undefined") document.documentElement.lang = state.resolved;
}

/** The stored preference, for the picker. */
export function uiPreference(): UiPreference {
  return state.preference;
}

/** The locale actually in use, for `Intl` formatting elsewhere. */
export function uiLocale(): string {
  return state.resolved;
}

export function setUiPreference(preference: UiPreference): void {
  state.preference = preference;
  state.resolved = resolve(preference);
  void i18next.changeLanguage(state.resolved);
  applyLang();
  try {
    localStorage.setItem(KEY, preference);
  } catch {
    // Not worth failing a language change over.
  }
}

/** A message key, checked against `en.json` — see `i18n/i18next.d.ts`. */
export type MessageId = ParseKeys<"app">;

/**
 * Translate an interface string.
 *
 * Reads `state.resolved` before delegating so every call registers the dependency:
 * `i18next` is not reactive, so without that a language change would not re-render.
 */
export function ui(id: MessageId, vars?: Record<string, string | number>): string {
  void state.resolved;
  return i18next.t(id, vars ?? {});
}
