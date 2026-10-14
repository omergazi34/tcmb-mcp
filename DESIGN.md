# tcmb-mcp: design notes

## What an MCP tool needs to get right

An MCP tool is an API whose caller is a language model. That changes some defaults:

- **Errors are part of the conversation.** "Unknown currency BTC" or "that date is in the
  future" are returned as tool results with `isError: true`, with a message that says what _is_
  valid, so the model can retry or explain. Protocol-level errors are reserved for real bugs and for
  arguments that fail schema validation (the SDK rejects those before the handler runs).
- **Provenance in every answer.** Every response states the bulletin date and number. When the
  requested date had no bulletin, the text says so explicitly ("No TCMB bulletin exists for
  2026-10-11 … showing 2026-10-09"). Otherwise a model will happily present Friday's rate as
  Sunday's.
- **Text and structure.** `content` is readable text (Markdown table, one-line summaries) for the
  model to quote; `structuredContent` matches a declared `outputSchema` for clients that compute with
  it. The SDK validates structured output against the schema, so the two can't silently drift.
- **Tool descriptions are prompts.** They state units ("TRY per unit of foreign currency"), defaults
  and limits, because that's all the model knows about the tool.
- **Annotations** (`readOnlyHint`, `idempotentHint`, `openWorldHint`) let hosts auto-approve these
  calls safely.

## The data source

`https://www.tcmb.gov.tr/kurlar/today.xml` (latest) and `…/kurlar/YYYYMM/DDMMYYYY.xml` (archive).
Facts that shaped the code, all checked against the live feed:

| Fact                                                                | Consequence                                                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| One bulletin per business day, ~15:30 Istanbul                      | "Today" is computed in `Europe/Istanbul`, not the server's timezone; before 15:30 today is a 404 |
| Weekends/holidays → HTTP 404                                        | Walk back to the previous bulletin (≤ 15 days, enough for the 9-day Kurban Bayramı)              |
| Weekends never have bulletins                                       | Skipped _without_ a request                                                                      |
| JPY is quoted per 100 units (`<Unit>100</Unit>`)                    | Every conversion divides by `unit`; a test pins 10,000 JPY = 3,109.45 TRY                        |
| Many currencies have empty banknote fields; XDR has no selling rate | Rates are `number \| null`; a missing rate is a clear error, never 0                             |
| Values are text like `0.03654`                                      | Parsed with `parseTagValue: false` and validated explicitly (no silent `NaN`)                    |

## Caching and load on TCMB

A published bulletin never changes, so:

- **Past bulletins are cached forever** (LRU, 1,024 entries ≈ 4 years of business days).
- **Days without a bulletin are cached too** (negative caching), so a holiday is looked up once.
  Exception: _today's_ 404 is cached for only 5 minutes, because that bulletin may still appear at 15:30.
- **`today.xml` is cached for 10 minutes.**
- **In-flight de-duplication.** Concurrent requests for the same day share one promise. A 30-day
  history and a conversion running in parallel don't fetch the same file twice.
- **Bounded concurrency** (6) for history requests, and hard range limits per interval (daily ≤ 93
  days, weekly ≤ 2 years, monthly ≤ 10 years). One tool call can never turn into thousands of
  requests to a central bank's website.

Retries happen only where they can help: network errors, 429 and 5xx, with exponential backoff.
Other 4xx fail immediately. Every request has a timeout (`AbortSignal.timeout`).

## Correctness details

- **Cross rates via TRY.** EUR→USD = (TRY per EUR) / (TRY per USD), using the same rate type on both
  sides. TCMB publishes `CrossRateUSD`/`CrossRateOther` only for some currencies, so deriving the rate
  is the only approach that works for every pair.
- **Rounding.** Results are rounded to 6 decimals. That is below TCMB's own precision (4-5) and
  removes float noise such as `4927.9400000000005` (which a test caught).
- **Default rate type is `forex_buying`** ("döviz alış"), the rate most commonly quoted as the
  official one. The model can choose any of the four.
- **Dates are validated as calendar dates** (2026-02-29 is rejected), not just with a regex.
- **History sampling.** Weekly/monthly series sample _on or before_ each target date and
  de-duplicate. A sample point before the archive starts is skipped (`NoBulletinError`) rather than
  failing the whole series.

## Testing strategy

- **Real fixture.** Parsing is tested against an actual bulletin from tcmb.gov.tr, not hand-written
  XML. The quirks above (unit 100, missing banknote rates, XDR) are therefore tested on real data.
- **Fake site, real failure modes.** `fakeTcmb` serves the fixture re-dated to any day and can return
  404s, 5xx, 403s or thrown network errors in sequence. Retry, fallback and caching are tested by
  counting HTTP calls.
- **Protocol-level tests.** The server is exercised by the SDK's real `Client` over
  `InMemoryTransport`: tool discovery, annotations, output schemas, `isError` results, input
  validation, resources and prompts. This is the same path a host takes.
- **Live check.** `test/live.test.ts` spawns the _built_ server over stdio and calls the real
  feed. It's skipped by default and scheduled weekly in `live.yml`, so a TCMB format change is caught early.
- **Injected clock.** The client takes `now()`, so "before 15:30", "holiday" and "future date" cases
  are deterministic.

## What I'd add next

- An HTTP (Streamable HTTP) transport for remote deployment, alongside stdio.
- Gold prices and interest rates from TCMB's EVDS API (needs a free API key).
- Publishing to npm so `npx tcmb-mcp` works without the GitHub prefix.
