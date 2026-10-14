import { XMLParser } from "fast-xml-parser";
import type { IsoDate } from "./dates.js";

export const RATE_TYPES = [
  "forex_buying",
  "forex_selling",
  "banknote_buying",
  "banknote_selling",
] as const;
export type RateType = (typeof RATE_TYPES)[number];

export interface CurrencyRate {
  code: string;
  /** Rates are quoted per `unit` (100 for JPY). */
  unit: number;
  name: string;
  nameTr: string;
  forex_buying: number | null;
  forex_selling: number | null;
  /** Banknote (cash) rates are not published for every currency. */
  banknote_buying: number | null;
  banknote_selling: number | null;
  /** Units of this currency per 1 USD, when TCMB publishes it. */
  cross_rate_usd: number | null;
  /** USD per 1 unit of this currency (EUR, GBP, KWD, XDR). */
  cross_rate_other: number | null;
}

export interface Bulletin {
  /** Date printed on the bulletin. */
  date: IsoDate;
  bulletinNo: string;
  rates: Record<string, CurrencyRate>;
}

export class BulletinParseError extends Error {
  override name = "BulletinParseError";
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  parseTagValue: false, // keep "0.03654" as text; we convert explicitly and validate
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => name === "Currency",
});

function toNumber(value: unknown, field: string, code: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") return null; // empty self-closing tags parse as ""
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new BulletinParseError(`${code}.${field}: not a valid number: "${value}"`);
  }
  return n;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** `10/13/2026` (the English `Date` attribute) -> `2026-10-13`. */
function usDateToIso(value: string): IsoDate {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (!match) throw new BulletinParseError(`unexpected bulletin date "${value}"`);
  const [, m, d, y] = match as unknown as [string, string, string, string];
  return `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
}

interface RawCurrency {
  "@CurrencyCode"?: string;
  Unit?: unknown;
  Isim?: unknown;
  CurrencyName?: unknown;
  ForexBuying?: unknown;
  ForexSelling?: unknown;
  BanknoteBuying?: unknown;
  BanknoteSelling?: unknown;
  CrossRateUSD?: unknown;
  CrossRateOther?: unknown;
}

interface RawBulletin {
  Tarih_Date?: {
    "@Date"?: string;
    "@Bulten_No"?: string;
    Currency?: RawCurrency[];
  };
}

/** Parse a TCMB daily bulletin (`today.xml` or `YYYYMM/DDMMYYYY.xml`). */
export function parseBulletin(xml: string): Bulletin {
  let doc: RawBulletin;
  try {
    doc = parser.parse(xml) as RawBulletin;
  } catch (error) {
    throw new BulletinParseError(`malformed XML: ${(error as Error).message}`);
  }
  const root = doc.Tarih_Date;
  if (!root?.["@Date"] || !root.Currency) {
    throw new BulletinParseError("not a TCMB bulletin: missing <Tarih_Date> or <Currency>");
  }
  const rates: Record<string, CurrencyRate> = {};
  for (const raw of root.Currency) {
    const code = raw["@CurrencyCode"];
    if (!code) continue;
    const unit = toNumber(raw.Unit, "Unit", code) ?? 1;
    rates[code] = {
      code,
      unit: unit > 0 ? unit : 1,
      name: text(raw.CurrencyName),
      nameTr: text(raw.Isim),
      forex_buying: toNumber(raw.ForexBuying, "ForexBuying", code),
      forex_selling: toNumber(raw.ForexSelling, "ForexSelling", code),
      banknote_buying: toNumber(raw.BanknoteBuying, "BanknoteBuying", code),
      banknote_selling: toNumber(raw.BanknoteSelling, "BanknoteSelling", code),
      cross_rate_usd: toNumber(raw.CrossRateUSD, "CrossRateUSD", code),
      cross_rate_other: toNumber(raw.CrossRateOther, "CrossRateOther", code),
    };
  }
  if (Object.keys(rates).length === 0) throw new BulletinParseError("bulletin has no currencies");
  return { date: usDateToIso(root["@Date"]), bulletinNo: root["@Bulten_No"] ?? "", rates };
}
