/**
 * Website metrics from Google Analytics 4 (Data API v1beta, properties/{id}:runReport) with a service account:
 * GA4_SERVICE_ACCOUNT_FILE = path to the account's JSON key; the account is added to the GA4 property as Viewer.
 * The access token is obtained with the OAuth 2.0 JWT bearer grant (RS256, scope analytics.readonly).
 *
 * Stored (dimension ""): web.sessions_period / web.sessions_baseline (all sessions of the property), web.landing_users
 * (totalUsers who landed on a page beginning with landingPagePath), web.landing_registrations (eventCount of the
 * registration event in those landing-page sessions). Period default: 30 days before the event start → event end
 * (not after today); baseline default: the equally long period right before it.
 */
import { createSign } from "node:crypto";
import type { ProviderConfig } from "@/lib/connectors/providers";
import { addDays, ConnectorError, daysBetween, eventDates, fetchJson, requireEnv, todayIstanbul, type Connector, type ConnectorContext } from "./core";

interface ServiceAccount { client_email: string; private_key: string; token_uri?: string }
interface Report { rows?: { dimensionValues?: { value: string }[]; metricValues?: { value: string }[] }[]; totals?: { metricValues?: { value: string }[] }[] }

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

export async function googleAccessToken(ctx: Pick<ConnectorContext<unknown>, "fetch" | "env" | "readFile" | "now">, scope: string) {
  const path = requireEnv("GA4", ctx, "GA4_SERVICE_ACCOUNT_FILE");
  let sa: ServiceAccount;
  try {
    sa = JSON.parse(await ctx.readFile(path)) as ServiceAccount;
  } catch {
    throw new ConnectorError("GA4", "GA4_SERVICE_ACCOUNT_FILE okunamadı veya geçerli bir JSON anahtarı değil.");
  }
  if (!sa.client_email || !sa.private_key) throw new ConnectorError("GA4", "Servis hesabı JSON'unda client_email veya private_key yok.");
  const aud = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  const iat = Math.floor(ctx.now.getTime() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iss: sa.client_email, scope, aud, iat, exp: iat + 3600 }))}`;
  let signature: string;
  try {
    signature = createSign("RSA-SHA256").update(unsigned).sign(sa.private_key).toString("base64url");
  } catch {
    throw new ConnectorError("GA4", "Servis hesabının özel anahtarı ile imza atılamadı.");
  }
  const token = await fetchJson<{ access_token?: string }>("GA4", ctx.fetch, aud, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${signature}` }).toString(),
  });
  if (!token.access_token) throw new ConnectorError("GA4", "Google erişim belirteci vermedi.");
  return token.access_token;
}

const num = (s: string | undefined) => (s === undefined ? 0 : Number(s) || 0);

export const ga4Connector: Connector<ProviderConfig<"GA4">> = async (ctx) => {
  const { config: c, event } = ctx;
  const { start, end } = eventDates("GA4", event);
  const today = todayIstanbul(ctx.now);
  const from = c.periodStart ?? addDays(start, -30);
  let to = c.periodEnd ?? end;
  if (to > today) to = today;
  if (to < from) throw new ConnectorError("GA4", "Dönem henüz başlamadı.");
  const len = daysBetween(from, to) + 1;
  const bTo = c.baselineEnd ?? addDays(from, -1);
  const bFrom = c.baselineStart ?? addDays(bTo, -(len - 1));

  const token = await googleAccessToken(ctx, "https://www.googleapis.com/auth/analytics.readonly");
  const run = (body: unknown) => fetchJson<Report>("GA4", ctx.fetch, `https://analyticsdata.googleapis.com/v1beta/properties/${c.propertyId}:runReport`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const landing = { filter: { fieldName: "landingPagePlusQueryString", stringFilter: { matchType: "BEGINS_WITH", value: c.landingPagePath } } };
  const sessions = async (startDate: string, endDate: string) =>
    num((await run({ dateRanges: [{ startDate, endDate }], metrics: [{ name: "sessions" }] })).rows?.[0]?.metricValues?.[0]?.value);

  const [sp, sb, users, regs] = await Promise.all([
    sessions(from, to),
    sessions(bFrom, bTo),
    run({ dateRanges: [{ startDate: from, endDate: to }], dimensions: [{ name: "landingPagePlusQueryString" }], metrics: [{ name: "totalUsers" }],
      dimensionFilter: landing, metricAggregations: ["TOTAL"] }),
    run({ dateRanges: [{ startDate: from, endDate: to }], dimensions: [{ name: "eventName" }, { name: "landingPagePlusQueryString" }], metrics: [{ name: "eventCount" }],
      dimensionFilter: { andGroup: { expressions: [landing, { filter: { fieldName: "eventName", stringFilter: { matchType: "EXACT", value: c.registrationEvent } } }] } } }),
  ]);
  // totalUsers is not additive across rows: use the report total (deduplicated by GA4).
  const landingUsers = users.totals?.[0]?.metricValues?.[0]?.value !== undefined
    ? num(users.totals[0]!.metricValues![0]!.value)
    : (users.rows ?? []).reduce((s, r) => s + num(r.metricValues?.[0]?.value), 0);
  const registrations = (regs.rows ?? []).reduce((s, r) => s + num(r.metricValues?.[0]?.value), 0);
  const detail = { period: [from, to], baseline: [bFrom, bTo], landingPagePath: c.landingPagePath, registrationEvent: c.registrationEvent };
  return {
    observations: [
      { key: "web.sessions_period", dimension: "", value: sp, detail },
      { key: "web.sessions_baseline", dimension: "", value: sb, detail },
      { key: "web.landing_users", dimension: "", value: landingUsers, detail },
      { key: "web.landing_registrations", dimension: "", value: registrations, detail },
    ],
    summary: `${from} – ${to}: ${sp} oturum (baz ${bFrom} – ${bTo}: ${sb}); ${c.landingPagePath}: ${landingUsers} kullanıcı, ${registrations} kayıt.`,
  };
};
