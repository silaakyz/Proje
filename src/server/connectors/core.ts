/**
 * Shared pieces of the external-data connectors: what a connector receives and returns, HTTP with a timeout, and
 * error messages that never carry a credential. Connectors are pure functions of their context, so tests run them
 * against recorded responses with an injected fetch.
 */
import type { Provider } from "@/lib/connectors/providers";

export interface ConnectorEvent {
  id: string;
  title: string;
  /** YYYY-MM-DD (Istanbul calendar); a connector that needs dates refuses an event without a start date. */
  startDate: string | null;
  endDate: string | null;
  city: string | null;
  /** HH:MM from the event profile; null = the whole day. */
  dailyStartTime: string | null;
  dailyEndTime: string | null;
}

export interface ConnectorContext<C> {
  event: ConnectorEvent;
  config: C;
  fetch: typeof fetch;
  env: (name: string) => string | undefined;
  /** Reads a local file (GA4 service account key); injectable for tests. */
  readFile: (path: string) => Promise<string>;
  now: Date;
}

export interface ObservationInput {
  key: string;
  dimension: string;
  value: number;
  observedAt?: Date | null;
  detail?: Record<string, unknown> | null;
}

export interface MentionInput {
  url: string;
  title: string | null;
  domain: string | null;
  publishedAt: Date | null;
  foundBy: "GDELT" | "GOOGLE_NEWS";
}

export interface ConnectorResult {
  observations: ObservationInput[];
  mentions?: MentionInput[];
  /** One line for the organizer: what was read. */
  summary: string;
}

export type Connector<C> = (ctx: ConnectorContext<C>) => Promise<ConnectorResult>;

/** An error whose message is safe to show the organizer (no key, no token). */
export class ConnectorError extends Error {
  constructor(public provider: Provider, message: string) {
    super(message);
  }
}

const SECRET_PARAMS = /([?&](?:key|access_token|api_key|token)=)[^&\s]+/gi;
export const maskUrl = (url: string) => url.replace(SECRET_PARAMS, "$1***");

/** Removes every configured secret value from a text, whatever form it took. */
export function scrub(text: string, secrets: readonly (string | undefined)[]) {
  let out = maskUrl(text);
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("***");
  return out.slice(0, 500);
}

export async function fetchJson<T>(
  provider: Provider,
  f: typeof fetch,
  url: string,
  init: RequestInit = {},
  timeoutMs = 20_000,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await f(url, { ...init, signal: ctrl.signal, headers: { accept: "application/json", ...(init.headers ?? {}) } });
  } catch (e) {
    const aborted = (e as Error).name === "AbortError";
    throw new ConnectorError(provider, aborted ? `${maskUrl(url)}: ${timeoutMs / 1000} sn içinde yanıt yok` : `${maskUrl(url)}: bağlantı kurulamadı`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
      detail = (typeof j.error === "string" ? j.error : j.error?.message) ?? j.message ?? detail;
    } catch { /* not JSON */ }
    throw new ConnectorError(provider, `HTTP ${res.status}: ${detail}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ConnectorError(provider, `beklenmeyen yanıt (JSON değil): ${text.slice(0, 120)}`);
  }
}

export function requireEnv(provider: Provider, ctx: { env: (n: string) => string | undefined }, name: string) {
  const v = ctx.env(name)?.trim();
  if (!v) throw new ConnectorError(provider, `Sunucuda ${name} tanımlı değil (.env).`);
  return v;
}

// ------------------------------------------------------------------------------------------- dates

export const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const today = (now: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul" }).format(now);

export function eventDates(provider: Provider, ev: ConnectorEvent) {
  if (!ev.startDate) throw new ConnectorError(provider, "Etkinliğin başlangıç tarihi yok.");
  return { start: ev.startDate, end: ev.endDate ?? ev.startDate };
}

/**
 * Promotion period (social, press, web): from 30 days before the event start to 14 days after its end, unless the
 * source sets its own dates; never later than today.
 */
export function promotionPeriod(provider: Provider, ev: ConnectorEvent, c: { periodStart?: string | null; periodEnd?: string | null }, now: Date) {
  const { start, end } = eventDates(provider, ev);
  const from = c.periodStart ?? addDays(start, -30);
  let to = c.periodEnd ?? addDays(end, 14);
  if (to > today(now)) to = today(now);
  if (to < from) throw new ConnectorError(provider, "Dönem henüz başlamadı.");
  return { from, to };
}

export const todayIstanbul = today;
