/** Next.js server start hook: automatic pulls of external data sources (src/server/connectors/scheduler.ts). */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startConnectorScheduler } = await import("@/server/connectors/scheduler");
  startConnectorScheduler();
}
