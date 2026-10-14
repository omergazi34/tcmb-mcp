import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { RATE_TYPES, type Bulletin } from "./bulletin.js";
import { availableCodes, convert, ConversionError } from "./convert.js";
import { daysBetween, parseIsoDate } from "./dates.js";
import { dateNote, num, pickRates, ratesTable } from "./format.js";
import { summarize, toPoints } from "./history.js";
import { TcmbClient, TcmbError, type Interval } from "./tcmb.js";

export const VERSION = "0.1.0";

/** Longest range per sampling interval; each daily point can cost one HTTP request to TCMB. */
export const MAX_RANGE_DAYS: Record<Interval, number> = { daily: 93, weekly: 731, monthly: 3660 };

const INSTRUCTIONS = `\
Official exchange rates of the Central Bank of the Republic of Türkiye (TCMB), quoted in Turkish lira.
- Rates are published once per business day around 15:30 Istanbul time. Weekends and public holidays
  have no bulletin; tools then return the most recent earlier bulletin and say so.
- forex_* are the rates used for transfers and official purposes; banknote_* are cash rates and are not
  published for every currency.
- Always tell the user the bulletin date the numbers come from.`;

const currency = z
  .string()
  .regex(/^[A-Za-z]{3}$/, "an ISO 4217 code such as USD")
  .describe("ISO 4217 currency code, e.g. USD, EUR, GBP, JPY. TRY is allowed for conversions.");
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "a date as YYYY-MM-DD")
  .describe("Date as YYYY-MM-DD (Istanbul calendar).");
const rateType = z
  .enum(RATE_TYPES)
  .describe(
    "Which TCMB rate to use. forex_buying ('döviz alış') is the commonly quoted official rate.",
  );

const rateShape = z.object({
  code: z.string(),
  name: z.string(),
  unit: z.number(),
  forex_buying: z.number().nullable(),
  forex_selling: z.number().nullable(),
  banknote_buying: z.number().nullable(),
  banknote_selling: z.number().nullable(),
});
const pointShape = z.object({ date: z.string(), rate: z.number() });

const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: true } as const;

function textResult(text: string, structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text }], structuredContent: structured };
}

/**
 * Domain errors (unknown currency, future date, TCMB unreachable) become tool results with
 * `isError: true`, so the model sees the message and can correct itself, instead of an opaque
 * protocol error.
 */
async function guarded(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    if (
      error instanceof TcmbError ||
      error instanceof ConversionError ||
      error instanceof RangeError
    ) {
      return { content: [{ type: "text", text: `Error: ${error.message}` }], isError: true };
    }
    throw error;
  }
}

function requireKnown(bulletin: Bulletin, codes: readonly string[]): void {
  const known = new Set(availableCodes(bulletin));
  const unknown = codes.filter((c) => !known.has(c));
  if (unknown.length) {
    throw new ConversionError(
      `unknown currency code(s) ${unknown.join(", ")}; TCMB publishes: ${[...known].join(", ")}`,
    );
  }
}

export function createServer(client: TcmbClient = new TcmbClient()): McpServer {
  const server = new McpServer(
    { name: "tcmb-mcp", title: "TCMB exchange rates", version: VERSION },
    { instructions: INSTRUCTIONS },
  );

  server.registerTool(
    "get_exchange_rates",
    {
      title: "Get TCMB exchange rates",
      description:
        "Official TCMB exchange rates (TRY per unit of foreign currency) for a date. " +
        "Omit `date` for the latest bulletin; omit `currencies` for all ~22 currencies.",
      inputSchema: {
        date: isoDate.optional(),
        currencies: z.array(currency).max(30).optional(),
      },
      outputSchema: {
        requested_date: z.string(),
        date: z.string(),
        bulletin_no: z.string(),
        rates: z.array(rateShape),
      },
      annotations: READ_ONLY,
    },
    ({ date, currencies }) =>
      guarded(async () => {
        const lookup = await client.onOrBefore(date);
        const codes = currencies?.map((c) => c.toUpperCase());
        if (codes)
          requireKnown(
            lookup.bulletin,
            codes.filter((c) => c !== "TRY"),
          );
        const rates = pickRates(lookup.bulletin, codes).map(
          ({
            code,
            name,
            unit,
            forex_buying,
            forex_selling,
            banknote_buying,
            banknote_selling,
          }) => ({
            code,
            name,
            unit,
            forex_buying,
            forex_selling,
            banknote_buying,
            banknote_selling,
          }),
        );
        return textResult(
          `${dateNote(lookup)}\n\n${ratesTable(pickRates(lookup.bulletin, codes))}`,
          {
            requested_date: lookup.requestedDate,
            date: lookup.bulletin.date,
            bulletin_no: lookup.bulletin.bulletinNo,
            rates,
          },
        );
      }),
  );

  server.registerTool(
    "convert_currency",
    {
      title: "Convert currency at TCMB rates",
      description:
        "Convert an amount between TRY and any TCMB currency, or between two foreign currencies " +
        "(cross rate via TRY). Uses the bulletin for `date`, or the latest one.",
      inputSchema: {
        amount: z.number().positive(),
        from: currency,
        to: currency,
        date: isoDate.optional(),
        rate_type: rateType.default("forex_buying"),
      },
      outputSchema: {
        amount: z.number(),
        from: z.string(),
        to: z.string(),
        result: z.number(),
        rate: z.number(),
        rate_type: z.enum(RATE_TYPES),
        date: z.string(),
        requested_date: z.string(),
      },
      annotations: READ_ONLY,
    },
    ({ amount, from, to, date, rate_type }) =>
      guarded(async () => {
        const lookup = await client.onOrBefore(date);
        const c = convert(lookup.bulletin, amount, from.toUpperCase(), to.toUpperCase(), rate_type);
        const text =
          `${num(c.amount, 2)} ${c.from} = ${num(c.result, 4, 2)} ${c.to}\n` +
          `Rate: 1 ${c.from} = ${num(c.rate, 6, 4)} ${c.to} (${c.rate_type}).\n${dateNote(lookup)}`;
        return textResult(text, {
          ...c,
          date: lookup.bulletin.date,
          requested_date: lookup.requestedDate,
        });
      }),
  );

  server.registerTool(
    "get_rate_history",
    {
      title: "Get TCMB rate history",
      description:
        "Time series of one currency's TCMB rate (TRY per 1 unit) with summary statistics: " +
        "first/last, min/max with dates, mean and % change. Ranges: daily up to " +
        `${MAX_RANGE_DAYS.daily} days, weekly up to ${MAX_RANGE_DAYS.weekly}, monthly up to ` +
        `${MAX_RANGE_DAYS.monthly}.`,
      inputSchema: {
        currency,
        start_date: isoDate,
        end_date: isoDate.optional().describe("Defaults to today."),
        interval: z.enum(["daily", "weekly", "monthly"]).default("daily"),
        rate_type: rateType.default("forex_buying"),
      },
      outputSchema: {
        currency: z.string(),
        rate_type: z.enum(RATE_TYPES),
        interval: z.string(),
        points: z.array(pointShape),
        stats: z
          .object({
            first: pointShape,
            last: pointShape,
            min: pointShape,
            max: pointShape,
            mean: z.number(),
            change_pct: z.number(),
            observations: z.number(),
          })
          .nullable(),
      },
      annotations: READ_ONLY,
    },
    ({ currency: code, start_date, end_date, interval, rate_type }) =>
      guarded(async () => {
        const end = end_date ?? client.today();
        parseIsoDate(start_date);
        parseIsoDate(end);
        const span = daysBetween(start_date, end);
        if (span > MAX_RANGE_DAYS[interval]) {
          throw new RangeError(
            `${interval} history is limited to ${MAX_RANGE_DAYS[interval]} days (requested ${span}); ` +
              `use a coarser interval`,
          );
        }
        const upper = code.toUpperCase();
        const bulletins = await client.series(start_date, end, interval);
        if (bulletins[0]) requireKnown(bulletins[0], [upper]);
        const points = toPoints(bulletins, upper, rate_type);
        const stats = summarize(points);
        const text = stats
          ? `${upper} ${rate_type}, ${interval}, ${stats.first.date} → ${stats.last.date} ` +
            `(${stats.observations} bulletins):\n` +
            `first ${num(stats.first.rate)} · last ${num(stats.last.rate)} · ` +
            `change ${stats.change_pct >= 0 ? "+" : ""}${stats.change_pct.toFixed(2)}%\n` +
            `min ${num(stats.min.rate)} on ${stats.min.date} · max ${num(stats.max.rate)} on ` +
            `${stats.max.date} · mean ${num(stats.mean)}`
          : `No ${upper} ${rate_type} rates were published between ${start_date} and ${end}.`;
        return textResult(text, { currency: upper, rate_type, interval, points, stats });
      }),
  );

  server.registerTool(
    "list_currencies",
    {
      title: "List TCMB currencies",
      description: "Currencies in the latest TCMB bulletin, with their quoting unit.",
      outputSchema: {
        date: z.string(),
        currencies: z.array(z.object({ code: z.string(), name: z.string(), unit: z.number() })),
      },
      annotations: READ_ONLY,
    },
    () =>
      guarded(async () => {
        const bulletin = await client.latest();
        const currencies = Object.values(bulletin.rates).map(({ code, name, unit }) => ({
          code,
          name,
          unit,
        }));
        const lines = currencies.map(
          (c) => `${c.code}  ${c.name}${c.unit === 1 ? "" : ` (quoted per ${c.unit})`}`,
        );
        return textResult(`Currencies in bulletin of ${bulletin.date}:\n${lines.join("\n")}`, {
          date: bulletin.date,
          currencies,
        });
      }),
  );

  server.registerResource(
    "latest-bulletin",
    "tcmb://bulletin/latest",
    {
      title: "Latest TCMB bulletin",
      description: "The most recent TCMB daily bulletin as JSON.",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(await client.latest(), null, 2),
        },
      ],
    }),
  );

  server.registerPrompt(
    "fx_briefing",
    {
      title: "Lira FX briefing",
      description: "Brief the user on how the lira moved against a currency recently.",
      argsSchema: {
        currency: z.string().optional().describe("ISO code, default USD"),
        days: z.string().optional().describe("Look-back window in days, default 30"),
      },
    },
    ({ currency: code, days }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text:
              `Using the TCMB tools, give me a short briefing on TRY against ${code ?? "USD"} ` +
              `over the last ${days ?? "30"} days: latest rate and its bulletin date, % change, ` +
              `the high and low with dates, and one sentence of context on the trend. ` +
              `Use forex_buying rates and cite bulletin dates.`,
          },
        },
      ],
    }),
  );

  return server;
}
