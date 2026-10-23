/**
 * Background jobs while the app runs: automatic pulls of external data sources and the deletion of registration
 * personal data past its retention period (src/server/registration/registration-service.ts).
 *
 * Automatic pulls while the app runs (started from src/instrumentation.ts in the Node.js server process): every
 * CHECK_MINUTES the scheduler pulls the sources that are due. How often a source is due is chosen per source on the
 * Veri Kaynakları page (provider defaults and limits: PROVIDER_INFO.sync). CONNECTORS_SYNC_INTERVAL_MINUTES=0 turns
 * automatic pulls off entirely (any other value is accepted for compatibility and ignored). Claiming in the database
 * (pullDueSources) keeps two processes from pulling the same source. For a server that is not always running,
 * schedule `npm run connectors:pull` instead (e.g. Windows Task Scheduler, cron).
 */
import "server-only";
import { pullDueSources } from "./data-sources-service";
import { purgeExpiredRegistrations } from "@/server/registration/registration-service";

const KEY = Symbol.for("eip.connectors.scheduler");
type Holder = { timer?: ReturnType<typeof setInterval>; running?: boolean };

/** How often the scheduler looks for due sources (the shortest per-source interval is 15 minutes). */
export const CHECK_MINUTES = 5;

export function automaticPullsEnabled() {
  return process.env.CONNECTORS_SYNC_INTERVAL_MINUTES?.trim() !== "0";
}

export function startConnectorScheduler() {
  const g = globalThis as unknown as Record<symbol, Holder>;
  const holder = (g[KEY] ??= {});
  if (holder.timer || !process.env.DATABASE_URL) return; // dev reloads register once; the KVKK purge always runs
  const tick = async () => {
    if (holder.running) return;
    holder.running = true;
    try {
      const results = automaticPullsEnabled() ? await pullDueSources() : [];
      if (results.length) {
        const failed = results.filter((r) => r.status === "ERROR").length;
        console.info(`[connectors] ${results.length} kaynak çekildi${failed ? `, ${failed} hata` : ""}`);
      }
    } catch (e) {
      console.warn(`[connectors] otomatik çekim yapılamadı: ${(e as Error).message}`);
    }
    // KVKK: personal data of registrations past their retention period (event end + retention_days)
    try {
      const purged = await purgeExpiredRegistrations();
      if (purged) console.info(`[kayıt] saklama süresi dolan ${purged} kaydın kişisel verisi silindi`);
    } catch (e) {
      console.warn(`[kayıt] süresi dolan kayıtlar silinemedi: ${(e as Error).message}`);
    } finally {
      holder.running = false;
    }
  };
  setTimeout(tick, 60_000).unref?.(); // first pass a minute after start
  holder.timer = setInterval(tick, CHECK_MINUTES * 60_000);
  holder.timer.unref?.();
}
