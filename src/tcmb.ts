import { parseBulletin, BulletinParseError, type Bulletin } from "./bulletin.js";
import { LruCache } from "./cache.js";
import {
  addDays,
  bulletinUrl,
  endOfMonth,
  isWeekend,
  parseIsoDate,
  todayInIstanbul,
  type IsoDate,
} from "./dates.js";

export class TcmbError extends Error {
  override name = "TcmbError";
}

/** No bulletin exists in the look-back window (e.g. a date before the archive starts). */
export class NoBulletinError extends TcmbError {
  override name = "NoBulletinError";
}

export type Interval = "daily" | "weekly" | "monthly";

export interface TcmbClientOptions {
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  baseUrl?: string;
  timeoutMs?: number;
  /** How far back to look for a bulletin before giving up. 15 covers the longest public holidays. */
  maxLookbackDays?: number;
  /** How long `latest()` may be served from cache. */
  latestTtlMs?: number;
  retries?: number;
  concurrency?: number;
}

export interface Lookup {
  requestedDate: IsoDate;
  bulletin: Bulletin;
}

const USER_AGENT = "tcmb-mcp/0.1 (+https://github.com/omergazi34/tcmb-mcp)";

/** Run `fn` over `items` with at most `limit` promises in flight, preserving order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Fetches TCMB's daily bulletins.
 *
 * - A bulletin, once published, never changes, so past bulletins are cached indefinitely.
 * - Days without a bulletin (weekends, holidays, "today" before 15:30) fall back to the most
 *   recent earlier bulletin. Callers get both the requested and the actual date, so an assistant
 *   can say "rates as of Friday" instead of silently presenting stale data.
 * - Concurrent requests for the same day share one HTTP call.
 */
export class TcmbClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly now: () => Date;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxLookbackDays: number;
  private readonly latestTtlMs: number;
  private readonly retries: number;
  private readonly concurrency: number;
  /** `null` records a confirmed day without a bulletin. */
  private readonly byDate: LruCache<IsoDate, Bulletin | null>;
  private readonly latestCache: LruCache<"latest", Bulletin>;
  private readonly inflight = new Map<string, Promise<Bulletin | null>>();
  requests = 0;

  constructor(options: TcmbClientOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? (() => new Date());
    this.baseUrl = options.baseUrl ?? "https://www.tcmb.gov.tr/kurlar";
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxLookbackDays = options.maxLookbackDays ?? 15;
    this.latestTtlMs = options.latestTtlMs ?? 10 * 60_000;
    this.retries = options.retries ?? 2;
    this.concurrency = options.concurrency ?? 6;
    const clock = () => this.now().getTime();
    this.byDate = new LruCache(1024, clock);
    this.latestCache = new LruCache(1, clock);
  }

  today(): IsoDate {
    return todayInIstanbul(this.now());
  }

  /** The most recently published bulletin. */
  async latest(): Promise<Bulletin> {
    const cached = this.latestCache.get("latest");
    if (cached) return cached;
    const xml = await this.request(`${this.baseUrl}/today.xml`);
    if (xml === null)
      throw new TcmbError("TCMB returned no current bulletin (today.xml not found)");
    const bulletin = this.parse(xml);
    this.latestCache.set("latest", bulletin, this.latestTtlMs);
    this.byDate.set(bulletin.date, bulletin);
    return bulletin;
  }

  /** The bulletin for `date`, or the closest earlier one. Without a date: the latest bulletin. */
  async onOrBefore(date?: IsoDate): Promise<Lookup> {
    const today = this.today();
    if (date === undefined) return { requestedDate: today, bulletin: await this.latest() };
    parseIsoDate(date);
    if (date > today)
      throw new TcmbError(`${date} is in the future (today is ${today} in Istanbul)`);
    let day = date;
    for (let i = 0; i <= this.maxLookbackDays; i++, day = addDays(day, -1)) {
      if (isWeekend(day)) continue;
      const bulletin = await this.forDate(day);
      if (bulletin) return { requestedDate: date, bulletin };
    }
    throw new NoBulletinError(
      `no TCMB bulletin found in the ${this.maxLookbackDays} days up to ${date}`,
    );
  }

  /** Bulletins in [start, end], sampled daily (every business day), weekly or monthly. */
  async series(start: IsoDate, end: IsoDate, interval: Interval): Promise<Bulletin[]> {
    if (start > end) throw new TcmbError("start_date must not be after end_date");
    const today = this.today();
    const last = end > today ? today : end;
    const targets: IsoDate[] = [];
    if (interval === "daily") {
      for (let d = start; d <= last; d = addDays(d, 1)) if (!isWeekend(d)) targets.push(d);
    } else if (interval === "weekly") {
      for (let d = last; d >= start; d = addDays(d, -7)) targets.push(d);
    } else {
      for (let d = endOfMonth(start); d < last; d = endOfMonth(addDays(d, 1))) targets.push(d);
      targets.push(last);
    }
    const found = await mapWithConcurrency(targets, this.concurrency, async (d) => {
      if (interval === "daily") return this.forDate(d);
      try {
        return (await this.onOrBefore(d)).bulletin;
      } catch (error) {
        if (error instanceof NoBulletinError) return null; // a gap in the archive, not a failure
        throw error;
      }
    });
    const unique = new Map<IsoDate, Bulletin>();
    for (const b of found) if (b && b.date >= start && b.date <= last) unique.set(b.date, b);
    return [...unique.values()].sort((a, b) => a.date.localeCompare(b.date));
  }

  private async forDate(date: IsoDate): Promise<Bulletin | null> {
    const cached = this.byDate.get(date);
    if (cached !== undefined) return cached;
    const pending = this.inflight.get(date);
    if (pending) return pending;
    const promise = this.fetchDate(date).finally(() => this.inflight.delete(date));
    this.inflight.set(date, promise);
    return promise;
  }

  private async fetchDate(date: IsoDate): Promise<Bulletin | null> {
    const xml = await this.request(bulletinUrl(date, this.baseUrl));
    if (xml === null) {
      // A missing past day is a holiday and stays missing. Today's bulletin may still appear
      // (it is published around 15:30), so only remember that briefly.
      this.byDate.set(date, null, date < this.today() ? Number.POSITIVE_INFINITY : 5 * 60_000);
      return null;
    }
    const bulletin = this.parse(xml);
    this.byDate.set(date, bulletin);
    return bulletin;
  }

  private parse(xml: string): Bulletin {
    try {
      return parseBulletin(xml);
    } catch (error) {
      if (error instanceof BulletinParseError) {
        throw new TcmbError(`unexpected response from TCMB: ${error.message}`);
      }
      throw error;
    }
  }

  /** GET with timeout and retries on network errors / 5xx. Resolves to `null` on 404. */
  private async request(url: string): Promise<string | null> {
    let lastError = "";
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 250 * 2 ** (attempt - 1)));
      this.requests++;
      try {
        const response = await this.fetchImpl(url, {
          headers: { Accept: "application/xml", "User-Agent": USER_AGENT },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (response.status === 404) return null;
        if (response.ok) return await response.text();
        lastError = `HTTP ${response.status}`;
        if (response.status < 500 && response.status !== 429) break;
      } catch (error) {
        lastError = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      }
    }
    throw new TcmbError(`request to ${url} failed: ${lastError}`);
  }
}
