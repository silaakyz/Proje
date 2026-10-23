/**
 * European Air Quality Index (EEA) from hourly concentrations, µg/m³ — the EEA's published bands
 * (https://airindex.eea.europa.eu/AQI): the index of an hour is the worst level among the pollutants measured.
 *
 *   level  name             PM2.5    PM10     O3       NO2      SO2
 *   1      Good             0–5      0–15     0–60     0–10     0–20
 *   2      Fair             6–15     16–45    61–100   11–25    21–40
 *   3      Moderate         16–50    46–120   101–120  26–60    41–125
 *   4      Poor             51–90    121–195  121–160  61–100   126–190
 *   5      Very poor        91–140   196–270  161–180  101–150  191–275
 *   6      Extremely poor   >140     >270     >180     >150     >275
 *
 * The bands are written in whole µg/m³, so a concentration is rounded to the nearest integer before it is placed.
 */
export const AIR_POLLUTANTS = ["pm2_5", "pm10", "ozone", "nitrogen_dioxide", "sulphur_dioxide"] as const;
export type AirPollutant = (typeof AIR_POLLUTANTS)[number];

/** Upper bound (inclusive) of levels 1–5; above the last one is level 6. */
const UPPER: Record<AirPollutant, readonly [number, number, number, number, number]> = {
  pm2_5: [5, 15, 50, 90, 140],
  pm10: [15, 45, 120, 195, 270],
  ozone: [60, 100, 120, 160, 180],
  nitrogen_dioxide: [10, 25, 60, 100, 150],
  sulphur_dioxide: [20, 40, 125, 190, 275],
};

export const AIR_LEVEL_LABEL = ["İyi", "Makul", "Orta", "Kötü", "Çok kötü", "Aşırı kötü"] as const;

export function pollutantLevel(pollutant: AirPollutant, concentration: number): number {
  const c = Math.round(concentration);
  const i = UPPER[pollutant].findIndex((u) => c <= u);
  return i === -1 ? 6 : i + 1;
}

/** Level of one hour from whatever pollutants have a value; null when none has one. */
export function hourLevel(values: Partial<Record<AirPollutant, number | null>>): number | null {
  let worst: number | null = null;
  for (const p of AIR_POLLUTANTS) {
    const x = values[p];
    if (x === null || x === undefined || !Number.isFinite(x) || x < 0) continue;
    const l = pollutantLevel(p, x);
    worst = worst === null ? l : Math.max(worst, l);
  }
  return worst;
}
