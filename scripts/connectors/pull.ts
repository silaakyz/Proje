/**
 * Pulls the external data sources that are due, once, and exits — for scheduling outside the app
 * (Windows Task Scheduler, cron):  npm run connectors:pull
 * Reads .env (DATABASE_URL and the providers' credentials). Same claiming as the in-app scheduler.
 */
import { config as loadEnv } from "dotenv";

loadEnv({ quiet: true });
const { pullDueSources } = await import("@/server/connectors/data-sources-service");
const results = await pullDueSources({ limit: 200 });
for (const r of results) console.log(`${r.provider}: ${r.status === "OK" ? r.summary : `HATA — ${r.error}`}`);
console.log(`${results.length} kaynak çekildi.`);
process.exit(results.some((r) => r.status === "ERROR") ? 2 : 0);
