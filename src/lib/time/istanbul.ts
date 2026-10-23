/** Today's calendar date in Europe/Istanbul as YYYY-MM-DD. */
export const todayIstanbul = (now: Date = new Date()): string =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul" }).format(now);
