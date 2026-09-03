/**
 * Which of the interface locales to use.
 *
 * The one piece of this that is not i18next's job. `i18next-browser-languagedetector`
 * exists for it, but it caches what it detected as though the user had chosen it —
 * which is wrong for a "match my browser" setting, because that setting has to keep
 * following the browser after the user changes their system language or travels.
 * Storing the *preference* and resolving it on every load is fifteen lines and does
 * not have that bug.
 */
/**
 * Pick the best available locale for a list of preferences.
 *
 * `navigator.languages` is in the user's order of preference and may carry regions
 * (`pl-PL`, `en-GB`), so each is tried whole and then by its base tag before moving on
 * to the next — a `pl-PL` speaker gets Polish, not English, from `["pl-PL", "en-US"]`.
 */
export function negotiateLocale(
  preferred: readonly string[],
  available: readonly string[],
  fallback: string,
): string {
  const lower = new Map(available.map((locale) => [locale.toLowerCase(), locale]));
  for (const want of preferred) {
    const tag = want.toLowerCase();
    const exact = lower.get(tag);
    if (exact !== undefined) return exact;
    const base = tag.split("-")[0];
    if (base !== undefined) {
      const loose = lower.get(base);
      if (loose !== undefined) return loose;
    }
  }
  return fallback;
}
