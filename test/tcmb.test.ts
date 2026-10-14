import { describe, expect, it } from "vitest";
import { TcmbError, mapWithConcurrency } from "../src/tcmb.js";
import { bulletinXml, makeClient } from "./helpers.js";

const MON = "2026-10-12";
const TUE = "2026-10-13";
const WED = "2026-10-14";

describe("TcmbClient.onOrBefore", () => {
  it("returns the bulletin for a business day", async () => {
    const { client, calls } = makeClient({ [MON]: bulletinXml(MON) });
    const { requestedDate, bulletin } = await client.onOrBefore(MON);
    expect(requestedDate).toBe(MON);
    expect(bulletin.date).toBe(MON);
    expect(calls).toEqual(["https://www.tcmb.gov.tr/kurlar/202610/12102026.xml"]);
  });

  it("skips weekends without making requests", async () => {
    const { client, calls } = makeClient({ "2026-10-09": bulletinXml("2026-10-09") });
    const { bulletin } = await client.onOrBefore("2026-10-11"); // Sunday
    expect(bulletin.date).toBe("2026-10-09"); // Friday
    expect(calls).toHaveLength(1);
  });

  it("falls back over public holidays", async () => {
    // 2026-10-29 (Thursday) is Republic Day: no bulletin, so the fake site answers 404.
    const { client, calls, setNow } = makeClient({ "2026-10-28": bulletinXml("2026-10-28") });
    setNow(new Date("2026-10-30T12:00:00Z"));
    const { requestedDate, bulletin } = await client.onOrBefore("2026-10-29");
    expect([requestedDate, bulletin.date]).toEqual(["2026-10-29", "2026-10-28"]);
    expect(calls).toHaveLength(2);
  });

  it("uses yesterday's bulletin before today's is published", async () => {
    const { client } = makeClient({ [TUE]: bulletinXml(TUE) });
    const { requestedDate, bulletin } = await client.onOrBefore(WED);
    expect([requestedDate, bulletin.date]).toEqual([WED, TUE]);
  });

  it("rejects future dates and gives up after the look-back window", async () => {
    const { client } = makeClient({});
    await expect(client.onOrBefore("2026-10-15")).rejects.toThrow(/in the future/);
    await expect(client.onOrBefore(MON)).rejects.toThrow(/no TCMB bulletin found in the 15 days/);
    await expect(client.onOrBefore("2026-13-01")).rejects.toThrow(RangeError);
  });

  it("caches bulletins and holidays, and shares in-flight requests", async () => {
    const { client, calls } = makeClient({ [MON]: bulletinXml(MON), [TUE]: bulletinXml(TUE) });
    await Promise.all([client.onOrBefore(MON), client.onOrBefore(MON), client.onOrBefore(MON)]);
    expect(calls).toHaveLength(1);
    await client.onOrBefore(MON);
    expect(calls).toHaveLength(1);
    await client.onOrBefore(WED); // WED is a 404, then TUE
    await client.onOrBefore(WED); // TUE cached; WED's 404 is cached briefly because it's today
    expect(calls).toHaveLength(3);
  });

  it("retries 5xx and network errors, but not other 4xx", async () => {
    const flaky = makeClient({ [MON]: [503, new TypeError("fetch failed"), bulletinXml(MON)] });
    expect((await flaky.client.onOrBefore(MON)).bulletin.date).toBe(MON);
    expect(flaky.calls).toHaveLength(3);

    const forbidden = makeClient({ [MON]: 403 });
    await expect(forbidden.client.onOrBefore(MON)).rejects.toThrow(/HTTP 403/);
    expect(forbidden.calls).toHaveLength(1);

    const down = makeClient({ [MON]: new TypeError("ECONNRESET") });
    await expect(down.client.onOrBefore(MON)).rejects.toThrow(TcmbError);
    expect(down.calls).toHaveLength(3);
  });

  it("turns unparseable responses into TcmbError", async () => {
    const { client } = makeClient({ [MON]: "<html>maintenance</html>" });
    await expect(client.onOrBefore(MON)).rejects.toThrow(/unexpected response from TCMB/);
  });
});

describe("TcmbClient.latest", () => {
  it("caches today.xml for a while", async () => {
    const { client, calls, setNow } = makeClient({ [TUE]: bulletinXml(TUE) });
    expect((await client.latest()).date).toBe(TUE);
    expect((await client.onOrBefore()).bulletin.date).toBe(TUE);
    expect(calls).toEqual(["https://www.tcmb.gov.tr/kurlar/today.xml"]);
    setNow(new Date("2026-10-14T10:11:00Z"));
    await client.latest();
    expect(calls).toHaveLength(2);
  });

  it("reports a missing today.xml", async () => {
    const { client } = makeClient({}, "2026-01-01");
    await expect(client.latest()).rejects.toThrow(/no current bulletin/);
  });
});

describe("TcmbClient.series", () => {
  const days = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", MON, TUE];
  const site = Object.fromEntries(days.map((d) => [d, bulletinXml(d)]));

  it("collects every business day for daily series, skipping holidays", async () => {
    const { client } = makeClient({ ...site, "2026-10-07": 404 });
    const series = await client.series("2026-10-04", WED, "daily");
    expect(series.map((b) => b.date)).toEqual(days.filter((d) => d !== "2026-10-07"));
  });

  it("samples weekly and monthly without duplicates", async () => {
    const { client } = makeClient(site);
    const weekly = await client.series("2026-10-01", TUE, "weekly");
    expect(weekly.map((b) => b.date)).toEqual(["2026-10-06", TUE]);
    const monthly = await client.series("2026-09-15", TUE, "monthly");
    expect(monthly.map((b) => b.date)).toEqual([TUE]); // no September data on the fake site
    await expect(client.series(TUE, MON, "daily")).rejects.toThrow(/start_date/);
  });
});

describe("mapWithConcurrency", () => {
  it("bounds parallelism and keeps order", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return n * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(peak).toBe(3);
  });
});
