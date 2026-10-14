import { readFileSync } from "node:fs";
import type { IsoDate } from "../src/dates.js";
import { TcmbClient } from "../src/tcmb.js";

/** A real bulletin, downloaded from tcmb.gov.tr on 2026-10-14 (bulletin of 2026-10-13). */
export const FIXTURE = readFileSync(new URL("./fixtures/13102026.xml", import.meta.url), "utf8");

/** The fixture re-dated to `date`, with the USD forex buying rate optionally replaced. */
export function bulletinXml(date: IsoDate, usdBuying?: number): string {
  const [y, m, d] = date.split("-");
  let xml = FIXTURE.replace(
    /Tarih="[^"]+" Date="[^"]+"/,
    `Tarih="${d}.${m}.${y}" Date="${m}/${d}/${y}"`,
  );
  if (usdBuying !== undefined) {
    xml = xml.replace(
      "<ForexBuying>49.2794</ForexBuying>",
      `<ForexBuying>${usdBuying}</ForexBuying>`,
    );
  }
  return xml;
}

type Reply = string | number | Error;

/**
 * A fake tcmb.gov.tr. `days` maps a date to its bulletin XML (or a status code / thrown error);
 * any other date is a 404, like a weekend or holiday on the real site.
 */
export function fakeTcmb(days: Record<IsoDate, Reply | Reply[]>, latest: IsoDate) {
  const calls: string[] = [];
  const queues = new Map(
    Object.entries(days).map(([k, v]) => [k, Array.isArray(v) ? [...v] : [v]]),
  );
  const fetch = (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    let date = latest;
    const match = /\/(\d{2})(\d{2})(\d{4})\.xml$/.exec(url);
    if (match) date = `${match[3]}-${match[2]}-${match[1]}`;
    const queue = queues.get(date);
    const reply = queue && queue.length > 1 ? queue.shift() : queue?.[0];
    if (reply === undefined) return Promise.resolve(new Response("not found", { status: 404 }));
    if (reply instanceof Error) return Promise.reject(reply);
    if (typeof reply === "number") return Promise.resolve(new Response("error", { status: reply }));
    const headers = { "content-type": "application/xml" };
    return Promise.resolve(new Response(reply, { status: 200, headers }));
  };
  return { fetch, calls };
}

/** 2026-10-14 13:00 in Istanbul: a Wednesday, before that day's bulletin is published. */
export const NOW = new Date("2026-10-14T10:00:00Z");

export function makeClient(days: Record<IsoDate, Reply | Reply[]>, latest: IsoDate = "2026-10-13") {
  const fake = fakeTcmb(days, latest);
  let now = NOW;
  const client = new TcmbClient({
    fetch: fake.fetch,
    now: () => now,
    retries: 2,
    timeoutMs: 1_000,
  });
  return {
    client,
    calls: fake.calls,
    setNow: (d: Date) => {
      now = d;
    },
  };
}
