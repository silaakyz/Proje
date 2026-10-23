/**
 * Automatic pulls while the app runs (started from src/instrumentation.ts in the Node.js server process): every
 * CONNECTORS_SYNC_INTERVAL_MINUTES (default 60; 0 = off) the due sources of events inside their window are pulled.
 * Claiming in the database (pullDueSources) keeps two processes from pulling the same source. For a server that
 * is not always running, schedule `npm run connectors:pull` instead (e.g. Windows Task Scheduler, cron).
 */
import "server-only";
import { pullDueSources } from "./data-sources-service";

const KEY = Symbol.for("eip.connectors.scheduler");
type Holder = { timer?: ReturnType<typeof setInterval>; running?: boolean };

export function intervalMinutes() {
  const raw = process.env.CONNECTORS_SYNC_INTERVAL_MINUTES?.trim();
  const n = raw === undefined || raw === "" ? 60 : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), 24 * 60) : 60;
}

export function startConnectorScheduler() {
  const minutes = intervalMinutes();
  const g = globalThis as unknown as Record<symbol, Holder>;
  const holder = (g[KEY] ??= {});
  if (holder.timer || minutes === 0 || !process.env.DATABASE_URL) return; // dev reloads register once
  const tick = async () => {
    if (holder.running) return;
    holder.running = true;
    try {
      const results = await pullDueSources(minutes);
      if (results.length) {
        const failed = results.filter((r) => r.status === "ERROR").length;
        console.info(`[connectors] ${results.length} kaynak çekildi${failed ? `, ${failed} hata` : ""}`);
      }
    } catch (e) {
      console.warn(`[connectors] otomatik çekim yapılamadı: ${(e as Error).message}`);
    } finally {
      holder.running = false;
    }
  };
  setTimeout(tick, 60_000).unref?.(); // first pass a minute after start
  holder.timer = setInterval(tick, minutes * 60_000);
  holder.timer.unref?.();
}
