// UI language: two locales, "ja" (product voice — soft hiragana) and "en"
// (full English). The dictionary is keyed by the JAPANESE source string —
// `t("部屋をつくる")` reads naturally at every call site and an untranslated
// key degrades to the Japanese text instead of a missing-key placeholder.
//
// Resolution order (first hit wins): ?lang=ja|en (persisted) ->
// localStorage -> explicit hint (Discord userLocale) -> navigator.languages
// -> "en" as the public-release fallback. setLocale writes the same key
// ?lang= does, so a manual switch survives reloads; applyLocaleHint (a
// boot-time Discord locale) never persists and never stomps an explicit pick.
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { EN } from "./en";

export type Locale = "ja" | "en";
export const LOCALES: readonly Locale[] = ["ja", "en"];

const STORAGE_KEY = "yuragoo:lang";

// Any locale-ish tag ("ja-JP", "en_US", Discord's userLocale) -> ours.
export const normalizeLocale = (raw: string | null | undefined): Locale | null => {
  if (raw === null || raw === undefined) return null;
  const tag = raw.toLowerCase().replace(/_/g, "-");
  if (tag === "ja" || tag.startsWith("ja-")) return "ja";
  if (tag === "en" || tag.startsWith("en-")) return "en";
  return null;
};

const stored = (): Locale | null => {
  try {
    if (typeof window === "undefined") return null;
    return normalizeLocale(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
};

const queryLang = (): Locale | null => {
  if (typeof window === "undefined") return null;
  return normalizeLocale(new URLSearchParams(window.location.search).get("lang"));
};

// True when the user picked a language (?lang= or a previous setLocale) —
// a later, weaker hint (Discord userLocale) must not stomp their choice.
export const hasExplicitLocale = (): boolean => queryLang() !== null || stored() !== null;

export const resolveLocale = (hint?: string | null): Locale => {
  const q = queryLang();
  if (q !== null) {
    try {
      window.localStorage.setItem(STORAGE_KEY, q);
    } catch {
      /* private mode */
    }
    return q;
  }
  const saved = stored();
  if (saved !== null) return saved;
  const fromHint = normalizeLocale(hint);
  if (fromHint !== null) return fromHint;
  if (typeof navigator !== "undefined") {
    for (const tag of [...(navigator.languages ?? []), navigator.language]) {
      const lang = normalizeLocale(tag);
      if (lang !== null) return lang;
    }
  }
  return "en";
};

const persistLocale = (locale: Locale): void => {
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    /* private mode */
  }
};

export type Vars = Record<string, string | number>;

// {name} placeholders interpolate in both languages. Missing vars leave the
// placeholder visible — a loud bug beats a silently wrong sentence.
const interpolate = (template: string, vars: Vars | undefined): string =>
  vars === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (m, name: string) =>
        Object.hasOwn(vars, name) ? String(vars[name]) : m,
      );

// The translator a component binds once: t("…日本語…", {vars}).
export type Translate = (ja: string, vars?: Vars) => string;

export const translate = (locale: Locale, ja: string, vars?: Vars): string =>
  interpolate(locale === "en" ? (EN[ja] ?? ja) : ja, vars);

// Non-React call sites (status builders, error mappers) take the locale
// explicitly — the caller resolves it via useLocale or resolveLocale.
export const tx = translate;

interface I18nControls {
  readonly setLocale: (locale: Locale) => void;
  // Soft, non-persisted override for a boot-time hint (Discord userLocale) —
  // no-ops when the user already chose a language explicitly.
  readonly applyHint: (raw: string | null | undefined) => void;
}

const LocaleContext = createContext<Locale>("ja");
const ControlsContext = createContext<I18nControls>({
  setLocale: () => {},
  applyHint: () => {},
});

// App-level owner of the UI locale. hint feeds resolveLocale's third step
// (below ?lang= and storage); applyHint lets a late-arriving Discord
// userLocale refine an UNCHOSEN locale after mount.
export const I18nRoot = ({
  hint,
  children,
}: {
  readonly hint?: string | null;
  readonly children: ReactNode;
}) => {
  const [locale, setLocaleState] = useState<Locale>(() => resolveLocale(hint));
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  const setLocale = useCallback((next: Locale) => {
    persistLocale(next);
    setLocaleState(next);
  }, []);
  const applyHint = useCallback((raw: string | null | undefined) => {
    if (hasExplicitLocale()) return;
    const lang = normalizeLocale(raw);
    if (lang !== null) setLocaleState((cur) => (cur === lang ? cur : lang));
  }, []);
  return createElement(
    LocaleContext.Provider,
    { value: locale },
    createElement(ControlsContext.Provider, { value: { setLocale, applyHint } }, children),
  );
};

export const useLocale = (): Locale => useContext(LocaleContext);
export const useI18nControls = (): I18nControls => useContext(ControlsContext);

export const useT = (): Translate => {
  const locale = useContext(LocaleContext);
  // Stable identity per locale — safe inside useCallback/useEffect deps.
  return useCallback((ja, vars) => translate(locale, ja, vars), [locale]);
};
