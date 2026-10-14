/** Calendar helpers. Dates are ISO `YYYY-MM-DD` strings in Türkiye's local calendar. */

export type IsoDate = string;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** Throws on malformed or impossible dates such as 2026-02-30. */
export function parseIsoDate(value: string): Date {
  const match = ISO_DATE.exec(value);
  if (!match) throw new RangeError(`invalid date "${value}", expected YYYY-MM-DD`);
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    throw new RangeError(`invalid date "${value}"`);
  }
  return date;
}

export function formatIsoDate(date: Date): IsoDate {
  return date.toISOString().slice(0, 10);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return formatIsoDate(new Date(parseIsoDate(date).getTime() + days * DAY_MS));
}

export function daysBetween(start: IsoDate, end: IsoDate): number {
  return Math.round((parseIsoDate(end).getTime() - parseIsoDate(start).getTime()) / DAY_MS);
}

/** TCMB never publishes on Saturdays or Sundays, so those days need no request. */
export function isWeekend(date: IsoDate): boolean {
  const day = parseIsoDate(date).getUTCDay();
  return day === 0 || day === 6;
}

/** "Today" as seen in Istanbul, which is what TCMB's bulletin dates refer to. */
export function todayInIstanbul(now: Date = new Date()): IsoDate {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul" }).format(now);
}

/** Last calendar day of the month that `date` falls in. */
export function endOfMonth(date: IsoDate): IsoDate {
  const d = parseIsoDate(date);
  return formatIsoDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
}

/** `https://www.tcmb.gov.tr/kurlar/202610/13102026.xml` for 2026-10-13. */
export function bulletinUrl(date: IsoDate, base = "https://www.tcmb.gov.tr/kurlar"): string {
  const [y, m, d] = date.split("-") as [string, string, string];
  return `${base}/${y}${m}/${d}${m}${y}.xml`;
}
