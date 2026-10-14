import type { Bulletin, RateType } from "./bulletin.js";

/** 6 decimals: below TCMB's own precision for every quoted currency, and free of float noise. */
export function round(value: number, decimals = 6): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export class ConversionError extends Error {
  override name = "ConversionError";
}

export function availableCodes(bulletin: Bulletin): string[] {
  return ["TRY", ...Object.keys(bulletin.rates).sort()];
}

/**
 * Turkish lira value of ONE unit of `code`. TCMB quotes some currencies per 100 units (JPY), so the
 * published rate is divided by its unit. Forgetting that makes yen conversions 100× wrong.
 */
export function tryPerUnit(bulletin: Bulletin, code: string, rateType: RateType): number {
  if (code === "TRY") return 1;
  const rate = bulletin.rates[code];
  if (!rate) {
    throw new ConversionError(
      `unknown currency "${code}"; TCMB publishes: ${availableCodes(bulletin).join(", ")}`,
    );
  }
  const value = rate[rateType];
  if (value === null) {
    throw new ConversionError(
      `TCMB does not publish a ${rateType.replace("_", " ")} rate for ${code}` +
        (rateType.startsWith("banknote") ? "; try a forex rate type" : ""),
    );
  }
  return value / rate.unit;
}

export interface Conversion {
  amount: number;
  from: string;
  to: string;
  result: number;
  /** 1 `from` = `rate` `to`. */
  rate: number;
  rate_type: RateType;
}

/** Convert through TRY, the currency every TCMB rate is quoted against. */
export function convert(
  bulletin: Bulletin,
  amount: number,
  from: string,
  to: string,
  rateType: RateType,
): Conversion {
  const rate = tryPerUnit(bulletin, from, rateType) / tryPerUnit(bulletin, to, rateType);
  return { amount, from, to, result: round(amount * rate), rate: round(rate), rate_type: rateType };
}
