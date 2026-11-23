import type { Lang } from './i18n';

const UNITS: Record<Lang, string[]> = {
  en: ['B', 'KB', 'MB', 'GB', 'TB', 'PB'],
  ru: ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ', 'ПБ'],
  zh: ['B', 'KB', 'MB', 'GB', 'TB', 'PB'],
  es: ['B', 'KB', 'MB', 'GB', 'TB', 'PB'],
};

const nfCache = new Map<string, Intl.NumberFormat>();
function nf(lang: Lang, opts: Intl.NumberFormatOptions): Intl.NumberFormat {
  const key = lang + JSON.stringify(opts);
  let f = nfCache.get(key);
  if (!f) {
    f = new Intl.NumberFormat(lang, opts);
    nfCache.set(key, f);
  }
  return f;
}

/** Binary units (like Explorer), one decimal for GB and above: "357.8 GB". */
export function fmtBytes(n: number, lang: Lang): string {
  const units = UNITS[lang];
  if (!Number.isFinite(n) || n <= 0) return `0 ${units[0]}`;
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i === 0 ? 0 : i >= 3 ? 1 : v >= 100 ? 0 : 1;
  return nf(lang, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v) + ' ' + units[i];
}

/** Splits "357.8 GB" into number and unit for typographic emphasis. */
export function bytesParts(n: number, lang: Lang): [string, string] {
  const s = fmtBytes(n, lang);
  const i = s.lastIndexOf(' ');
  return [s.slice(0, i), s.slice(i + 1)];
}

export const fmtCount = (n: number, lang: Lang) => nf(lang, {}).format(n);
export const fmtCompact = (n: number, lang: Lang) => nf(lang, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
export const fmtPercent = (x: number, lang: Lang) =>
  nf(lang, { style: 'percent', maximumFractionDigits: x < 0.1 ? 1 : 0 }).format(Math.max(0, x));

export function fmtDuration(ms: number, lang: Lang): string {
  const s = ms / 1000;
  if (s < 90) return nf(lang, { style: 'unit', unit: 'second', unitDisplay: 'short', maximumFractionDigits: s < 10 ? 1 : 0 }).format(s);
  return nf(lang, { style: 'unit', unit: 'minute', unitDisplay: 'short', maximumFractionDigits: 1 }).format(s / 60);
}

const rtfCache = new Map<Lang, Intl.RelativeTimeFormat>();
export function fmtAgo(sec: number, lang: Lang): string {
  if (!sec) return '—';
  let rtf = rtfCache.get(lang);
  if (!rtf) {
    rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
    rtfCache.set(lang, rtf);
  }
  const diff = Date.now() / 1000 - sec;
  if (diff < 3600) return rtf.format(-Math.max(1, Math.round(diff / 60)), 'minute');
  if (diff < 86400) return rtf.format(-Math.round(diff / 3600), 'hour');
  if (diff < 86400 * 31) return rtf.format(-Math.round(diff / 86400), 'day');
  if (diff < 86400 * 365) return rtf.format(-Math.round(diff / (86400 * 30.4)), 'month');
  return rtf.format(-Math.round(diff / (86400 * 365)), 'year');
}

export function fmtDate(sec: number, lang: Lang): string {
  if (!sec) return '—';
  return new Date(sec * 1000).toLocaleDateString(lang, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function shortPath(p: string, home: string): string {
  const sep = home.startsWith('/') ? '/' : '\\';
  if (!home) return p;
  const prefix = sep === '/' ? home : home.toLowerCase();
  const full = sep === '/' ? p : p.toLowerCase();
  if (full === prefix || full.startsWith(prefix + sep)) return '~' + p.slice(home.length);
  return p;
}

export function parentPath(p: string): string {
  const i = p.replace(/[\\/]+$/, '').lastIndexOf('\\');
  return i > 2 ? p.slice(0, i) : p.slice(0, 3);
}
