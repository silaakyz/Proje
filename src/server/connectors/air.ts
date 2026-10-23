/**
 * Hourly air quality at the event location during the event hours (Open-Meteo Air Quality API, Copernicus CAMS
 * model; no key). Location: configured coordinates, else the configured city or the event profile's city, geocoded
 * with Open-Meteo's geocoding API (Türkiye first). Event hours: each event day from the profile's daily start to
 * end time, otherwise the whole day. Stored per hour and pollutant: key "air.<pollutant>", dimension = local hour.
 */
import { AIR_POLLUTANTS } from "@/lib/connectors/air-quality";
import type { ProviderConfig } from "@/lib/connectors/providers";
import { ConnectorError, eventDates, fetchJson, todayIstanbul, type Connector, type ObservationInput } from "./core";

const AIR_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";
const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";

interface GeoResponse { results?: { name: string; latitude: number; longitude: number; country_code?: string; admin1?: string }[] }
interface AirResponse { hourly?: { time: string[] } & Partial<Record<(typeof AIR_POLLUTANTS)[number], (number | null)[]>> }

export const airConnector: Connector<ProviderConfig<"OPEN_METEO_AIR">> = async (ctx) => {
  const { event, config, fetch: f } = ctx;
  const { start, end } = eventDates("OPEN_METEO_AIR", event);
  if (start > todayIstanbul(ctx.now)) throw new ConnectorError("OPEN_METEO_AIR", "Etkinlik henüz başlamadı; hava kalitesi etkinlik günlerinde çekilir.");

  let lat = config.latitude, lon = config.longitude, place = "koordinat";
  if (lat === null || lon === null) {
    const city = config.city ?? event.city;
    if (!city) throw new ConnectorError("OPEN_METEO_AIR", "Konum yok: kaynak ayarına şehir veya koordinat girin.");
    const geo = await fetchJson<GeoResponse>("OPEN_METEO_AIR", f, `${GEO_URL}?${new URLSearchParams({ name: city, count: "5", language: "tr", format: "json" })}`);
    const hit = geo.results?.find((r) => r.country_code === "TR") ?? geo.results?.[0];
    if (!hit) throw new ConnectorError("OPEN_METEO_AIR", `"${city}" için konum bulunamadı.`);
    lat = hit.latitude; lon = hit.longitude; place = [hit.name, hit.admin1].filter(Boolean).join(", ");
  }

  const endDate = end > todayIstanbul(ctx.now) ? todayIstanbul(ctx.now) : end;
  const q = new URLSearchParams({
    latitude: String(lat), longitude: String(lon), hourly: AIR_POLLUTANTS.join(","), start_date: start, end_date: endDate, timezone: "Europe/Istanbul",
  });
  const data = await fetchJson<AirResponse>("OPEN_METEO_AIR", f, `${AIR_URL}?${q}`);
  const times = data.hourly?.time ?? [];
  const inHours = (t: string) => {
    const hm = t.slice(11, 16);
    if (!event.dailyStartTime || !event.dailyEndTime) return true;
    return event.dailyStartTime <= event.dailyEndTime
      ? hm >= event.dailyStartTime && hm < event.dailyEndTime
      : hm >= event.dailyStartTime || hm < event.dailyEndTime; // past midnight
  };
  const observations: ObservationInput[] = [];
  let hours = 0;
  times.forEach((t, i) => {
    if (!inHours(t)) return;
    let any = false;
    for (const p of AIR_POLLUTANTS) {
      const x = data.hourly?.[p]?.[i];
      if (x === null || x === undefined || !Number.isFinite(x)) continue;
      observations.push({ key: `air.${p}`, dimension: t, value: x, observedAt: new Date(`${t}:00+03:00`) });
      any = true;
    }
    if (any) hours++;
  });
  return { observations, summary: `${place} (${lat!.toFixed(3)}, ${lon!.toFixed(3)}): ${hours} etkinlik saati.` };
};
