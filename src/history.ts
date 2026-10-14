import type { Bulletin, RateType } from "./bulletin.js";
import { tryPerUnit } from "./convert.js";
import type { IsoDate } from "./dates.js";

export interface Point {
  date: IsoDate;
  rate: number;
}

export interface HistoryStats {
  first: Point;
  last: Point;
  min: Point;
  max: Point;
  mean: number;
  change_pct: number;
  observations: number;
}

/** TRY per one unit of `code` on every bulletin that publishes that rate. */
export function toPoints(
  bulletins: readonly Bulletin[],
  code: string,
  rateType: RateType,
): Point[] {
  const points: Point[] = [];
  for (const bulletin of bulletins) {
    const rate = bulletin.rates[code];
    if (rate?.[rateType] == null) continue; // currency or rate type not published that day
    points.push({ date: bulletin.date, rate: tryPerUnit(bulletin, code, rateType) });
  }
  return points;
}

export function summarize(points: readonly Point[]): HistoryStats | null {
  const [first] = points;
  const last = points.at(-1);
  if (!first || !last) return null;
  let min = first;
  let max = first;
  let sum = 0;
  for (const p of points) {
    if (p.rate < min.rate) min = p;
    if (p.rate > max.rate) max = p;
    sum += p.rate;
  }
  return {
    first,
    last,
    min,
    max,
    mean: sum / points.length,
    change_pct: ((last.rate - first.rate) / first.rate) * 100,
    observations: points.length,
  };
}
