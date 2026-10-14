import type { Bulletin, CurrencyRate } from "./bulletin.js";
import type { Lookup } from "./tcmb.js";

/** TCMB prints rates with 4-5 decimals; keep that, and never use exponent notation. */
export function num(value: number | null, maxDigits = 5, minDigits = 4): string {
  if (value === null) return "-";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: Math.min(minDigits, maxDigits),
    maximumFractionDigits: maxDigits,
    useGrouping: false,
  });
}

/** Tells the model when it is looking at an earlier bulletin than the one it asked for. */
export function dateNote(lookup: Lookup): string {
  const { requestedDate, bulletin } = lookup;
  if (requestedDate === bulletin.date)
    return `TCMB bulletin ${bulletin.bulletinNo} of ${bulletin.date}.`;
  return (
    `No TCMB bulletin exists for ${requestedDate} (weekend, public holiday, or not yet published ` +
    `- bulletins appear around 15:30 Istanbul time). Showing the most recent earlier bulletin: ` +
    `${bulletin.bulletinNo} of ${bulletin.date}.`
  );
}

export function ratesTable(rates: CurrencyRate[]): string {
  const header =
    "| Code | Currency | Unit | Forex buying | Forex selling | Banknote buying | Banknote selling |\n" +
    "|---|---|---:|---:|---:|---:|---:|";
  const rows = rates.map(
    (r) =>
      `| ${r.code} | ${r.name} | ${r.unit} | ${num(r.forex_buying)} | ${num(r.forex_selling)} ` +
      `| ${num(r.banknote_buying)} | ${num(r.banknote_selling)} |`,
  );
  return [header, ...rows].join("\n");
}

export function pickRates(
  bulletin: Bulletin,
  codes: readonly string[] | undefined,
): CurrencyRate[] {
  const all = Object.values(bulletin.rates);
  if (!codes?.length) return all;
  return codes
    .map((code) => bulletin.rates[code])
    .filter((r): r is CurrencyRate => r !== undefined);
}
