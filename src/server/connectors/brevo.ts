/**
 * E-mail campaign statistics from Brevo: GET https://api.brevo.com/v3/emailCampaigns/{id}?statistics=globalStats,
 * header `api-key` (BREVO_API_KEY). Stored per campaign: email.sent, email.delivered, email.unique_opens
 * (globalStats.uniqueViews), email.unique_clicks, email.hard_bounces, email.soft_bounces.
 */
import type { ProviderConfig } from "@/lib/connectors/providers";
import { fetchJson, requireEnv, type Connector, type ObservationInput } from "./core";

interface Stats { sent?: number; delivered?: number; uniqueViews?: number; uniqueClicks?: number; hardBounces?: number; softBounces?: number }
interface Campaign { id: number; name?: string; status?: string; sentDate?: string; statistics?: { globalStats?: Stats } }

const FIELDS: [keyof Stats, string][] = [
  ["sent", "email.sent"], ["delivered", "email.delivered"], ["uniqueViews", "email.unique_opens"],
  ["uniqueClicks", "email.unique_clicks"], ["hardBounces", "email.hard_bounces"], ["softBounces", "email.soft_bounces"],
];

export const brevoConnector: Connector<ProviderConfig<"BREVO">> = async (ctx) => {
  const key = requireEnv("BREVO", ctx, "BREVO_API_KEY");
  const observations: ObservationInput[] = [];
  const names: string[] = [];
  for (const id of ctx.config.campaignIds) {
    const c = await fetchJson<Campaign>("BREVO", ctx.fetch,
      `https://api.brevo.com/v3/emailCampaigns/${id}?statistics=globalStats&excludeHtmlContent=true`, { headers: { "api-key": key } });
    const s = c.statistics?.globalStats ?? {};
    for (const [field, obsKey] of FIELDS) {
      const value = Number(s[field] ?? 0);
      observations.push({ key: obsKey, dimension: `campaign:${id}`, value: Number.isFinite(value) ? value : 0,
        observedAt: c.sentDate ? new Date(c.sentDate) : null, detail: field === "sent" ? { name: c.name ?? null, status: c.status ?? null } : null });
    }
    names.push(c.name ? `${c.name} (#${id})` : `#${id}`);
  }
  return { observations, summary: `${names.length} kampanya: ${names.join(", ").slice(0, 300)}.` };
};
