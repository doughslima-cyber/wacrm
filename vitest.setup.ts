// The suite assumes the CI runtime: locale en-US, time zone UTC
// (vitest.config.ts sets TZ). Node takes its default ICU locale from
// the OS, and on Windows it ignores LANG / LC_ALL, so a pt-BR machine
// formats "1.234" where the tests expect "1,234". Pin the default
// locale for calls that don't pass one; explicit locales are untouched.

const DEFAULT_LOCALE = "en-US";

type Ctor = new (locales?: string | string[], options?: object) => object;

for (const name of [
  "Collator",
  "DateTimeFormat",
  "ListFormat",
  "NumberFormat",
  "PluralRules",
  "RelativeTimeFormat",
] as const) {
  const Original = Intl[name] as unknown as Ctor & { supportedLocalesOf: unknown };
  const Pinned = function (locales?: string | string[], options?: object) {
    return new Original(locales ?? DEFAULT_LOCALE, options);
  } as unknown as Ctor & { supportedLocalesOf: unknown };
  Pinned.prototype = Original.prototype;
  Pinned.supportedLocalesOf = Original.supportedLocalesOf;
  (Intl as unknown as Record<string, unknown>)[name] = Pinned;
}

function pin<T>(proto: T, method: keyof T) {
  const original = proto[method] as unknown as (this: unknown, ...args: unknown[]) => unknown;
  proto[method] = function (this: unknown, locales?: unknown, ...rest: unknown[]) {
    return original.call(this, locales ?? DEFAULT_LOCALE, ...rest);
  } as T[keyof T];
}

pin(Number.prototype, "toLocaleString");
pin(Date.prototype, "toLocaleString");
pin(Date.prototype, "toLocaleDateString");
pin(Date.prototype, "toLocaleTimeString");
