import type { I18nStrings, I18nContext } from "../types.js";
import { formatDate as engineFormatDate } from "../date-engine.js";
import { en } from "./en.js";
import { es } from "./es.js";
import { ar } from "./ar.js";

const locales = new Map<string, I18nStrings>();

// Register defaults
locales.set("en", en);
locales.set("es", es);
locales.set("ar", ar);

/**
 * Registers a new or custom locale string set.
 */
export function registerLocale(strings: I18nStrings): void {
  locales.set(strings.locale.toLowerCase(), strings);
}

/**
 * Lists all registered locale codes.
 */
export function getAvailableLocales(): string[];
export function getAvailableLocales(): string[] {
  return Array.from(locales.keys());
}

/**
 * Creates an active I18nContext for a given locale code.
 */
export function createI18n(locale: string = "en"): I18nContext {
  const normLocale = locale.toLowerCase().split("-")[0];
  const strings = locales.get(normLocale) || locales.get("en") || en;

  return {
    strings,

    formatDate(dateStr, options) {
      return engineFormatDate(dateStr, strings.locale, options);
    },

    formatDateRange(start, end, options) {
      const formattedStart = engineFormatDate(start, strings.locale, options);
      if (!end) {
        return `${formattedStart} – ${strings.dates.present}`;
      }
      const formattedEnd = engineFormatDate(end, strings.locale, options);
      return `${formattedStart} ${strings.dates.to} ${formattedEnd}`;
    },

    isRTL() {
      return strings.dir === "rtl";
    },
  };
}

export { en, es, ar };
