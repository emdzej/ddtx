/**
 * Types every message key off `en.json`.
 *
 * This is what replaces the compile-time guarantee the TypeScript catalogues gave:
 * `ui("strip.readNwo")` is a type error, and so is a key that has been renamed out of
 * the catalogue. What it does *not* check is whether `pl.json` has the same keys —
 * i18next types resources against one language by design, so parity is a test
 * (`i18n/parity.test.ts`) rather than a type.
 */

import type en from "./locales/en.json";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "app";
    resources: { app: typeof en };
    // Plurals live in the key as `_one` / `_few` / `_many` / `_other` suffixes, which
    // is i18next v21+ behaviour and matches `Intl.PluralRules` categories.
    jsonFormat: "v4";
  }
}
