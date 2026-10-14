import { describe, expect, it } from "vitest";
import { BulletinParseError, parseBulletin } from "../src/bulletin.js";
import { LruCache } from "../src/cache.js";
import { ConversionError, convert, tryPerUnit } from "../src/convert.js";
import {
  addDays,
  bulletinUrl,
  daysBetween,
  endOfMonth,
  isWeekend,
  parseIsoDate,
  todayInIstanbul,
} from "../src/dates.js";
import { summarize, toPoints } from "../src/history.js";
import { FIXTURE, bulletinXml } from "./helpers.js";

describe("dates", () => {
  it("validates calendar dates", () => {
    expect(parseIsoDate("2024-02-29").toISOString()).toBe("2024-02-29T00:00:00.000Z");
    expect(() => parseIsoDate("2026-02-29")).toThrow(RangeError);
    expect(() => parseIsoDate("2026-1-5")).toThrow(/YYYY-MM-DD/);
  });

  it("does calendar arithmetic across month and year boundaries", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(daysBetween("2026-01-01", "2026-12-31")).toBe(364);
    expect(endOfMonth("2024-02-10")).toBe("2024-02-29");
  });

  it("knows weekends and Istanbul's calendar day", () => {
    expect(isWeekend("2026-10-17")).toBe(true); // Saturday
    expect(isWeekend("2026-10-16")).toBe(false);
    // 22:30 UTC on the 13th is already the 14th in Istanbul (UTC+3).
    expect(todayInIstanbul(new Date("2026-10-13T22:30:00Z"))).toBe("2026-10-14");
  });

  it("builds TCMB archive URLs", () => {
    expect(bulletinUrl("2026-01-05")).toBe("https://www.tcmb.gov.tr/kurlar/202601/05012026.xml");
  });
});

describe("parseBulletin", () => {
  const bulletin = parseBulletin(FIXTURE);

  it("reads the header and every currency", () => {
    expect(bulletin.date).toBe("2026-10-13");
    expect(bulletin.bulletinNo).toBe("2026/193");
    expect(Object.keys(bulletin.rates)).toHaveLength(22);
    expect(bulletin.rates.USD).toMatchObject({
      unit: 1,
      name: "US DOLLAR",
      nameTr: "ABD DOLARI",
      forex_buying: 49.2794,
      forex_selling: 49.3681,
      banknote_buying: 49.2449,
      banknote_selling: 49.4422,
      cross_rate_usd: null,
    });
  });

  it("handles the quirks of the real feed", () => {
    expect(bulletin.rates.JPY?.unit).toBe(100);
    expect(bulletin.rates.RON?.banknote_buying).toBeNull();
    expect(bulletin.rates.XDR?.forex_selling).toBeNull();
    expect(bulletin.rates.EUR?.cross_rate_other).toBe(1.1184);
    expect(bulletin.rates.KRW?.forex_buying).toBe(0.03654);
  });

  it.each([
    ["<html><body>Bakım çalışması</body></html>", /not a TCMB bulletin/],
    ['<Tarih_Date Date="2026-10-13"><Currency CurrencyCode="USD"/></Tarih_Date>', /bulletin date/],
    [FIXTURE.replace("49.2794", "abc"), /USD.ForexBuying/],
  ])("rejects unexpected documents", (xml, message) => {
    expect(() => parseBulletin(xml)).toThrow(BulletinParseError);
    expect(() => parseBulletin(xml)).toThrow(message);
  });
});

describe("LruCache", () => {
  it("evicts the least recently used entry", () => {
    const cache = new LruCache<string, number>(2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe(1);
    expect(cache.size).toBe(2);
  });

  it("expires entries after their TTL", () => {
    let now = 0;
    const cache = new LruCache<string, number>(5, () => now);
    cache.set("x", 1, 100);
    now = 99;
    expect(cache.get("x")).toBe(1);
    now = 100;
    expect(cache.get("x")).toBeUndefined();
    expect(() => new LruCache(0)).toThrow(RangeError);
  });
});

describe("convert", () => {
  const bulletin = parseBulletin(FIXTURE);

  it("converts to and from TRY", () => {
    expect(convert(bulletin, 100, "USD", "TRY", "forex_buying").result).toBeCloseTo(4927.94, 6);
    expect(convert(bulletin, 4927.94, "TRY", "USD", "forex_buying").result).toBeCloseTo(100, 6);
  });

  it("computes cross rates through TRY", () => {
    const eurUsd = convert(bulletin, 1, "EUR", "USD", "forex_buying").rate;
    expect(eurUsd).toBeCloseTo(55.1128 / 49.2794, 6);
  });

  it("divides by the quoting unit (JPY is per 100)", () => {
    expect(tryPerUnit(bulletin, "JPY", "forex_buying")).toBeCloseTo(0.310945, 10);
    expect(convert(bulletin, 10_000, "JPY", "TRY", "forex_buying").result).toBeCloseTo(3109.45, 6);
  });

  it("explains unavailable rates and unknown currencies", () => {
    expect(() => tryPerUnit(bulletin, "CNY", "banknote_selling")).toThrow(/try a forex rate type/);
    expect(() => tryPerUnit(bulletin, "XDR", "forex_selling")).toThrow(ConversionError);
    expect(() => tryPerUnit(bulletin, "BTC", "forex_buying")).toThrow(/TCMB publishes: TRY, AED/);
  });
});

describe("history", () => {
  const days = ["2026-10-06", "2026-10-07", "2026-10-08"].map((d, i) =>
    parseBulletin(bulletinXml(d, [49, 50, 48.5][i])),
  );

  it("summarises a series", () => {
    const stats = summarize(toPoints(days, "USD", "forex_buying"));
    expect(stats).toMatchObject({
      first: { date: "2026-10-06", rate: 49 },
      last: { date: "2026-10-08", rate: 48.5 },
      min: { date: "2026-10-08" },
      max: { date: "2026-10-07", rate: 50 },
      observations: 3,
    });
    expect(stats?.mean).toBeCloseTo(49.1667, 4);
    expect(stats?.change_pct).toBeCloseTo(-1.0204, 4);
  });

  it("skips days where the rate is not published", () => {
    expect(toPoints(days, "XDR", "forex_selling")).toEqual([]);
    expect(summarize([])).toBeNull();
  });
});
