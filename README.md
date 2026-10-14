# tcmb-mcp

[![CI](https://github.com/omergazi34/tcmb-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/omergazi34/tcmb-mcp/actions/workflows/ci.yml)
[![Live TCMB check](https://github.com/omergazi34/tcmb-mcp/actions/workflows/live.yml/badge.svg)](https://github.com/omergazi34/tcmb-mcp/actions/workflows/live.yml)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)
![Coverage](https://img.shields.io/badge/coverage-98%25-brightgreen)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI assistants
(Claude, Cursor, any MCP client) the **official exchange rates of the Central Bank of the
Republic of Türkiye (TCMB)**: daily rates, historical series and currency conversion, with correct
handling of weekends, holidays and the 15:30 publication time.

> **You:** How much is 1,000 euros in lira, and how has the dollar moved this past month?
>
> **Claude** _(calls `convert_currency` and `get_rate_history`)_: At TCMB's latest forex buying
> rate (bulletin 2026/193, 13 October 2026), €1,000 = **₺55,112.80**. Over the past month the dollar
> rose **1.54%** against the lira, from 48.5343 on 14 September to 49.2794. That is the high of the
> period; the low was the starting point.

## Why

LLMs don't know today's exchange rate, and when they guess, they guess confidently. The TCMB feed
is public, but using it correctly takes some care:

- Rates are published **once per business day around 15:30** Istanbul time. There is no bulletin on
  weekends, public holidays, or before 15:30, and the archive URL simply returns 404.
- Some currencies are quoted **per 100 units** (JPY), so a naive conversion is off by 100×.
- **Cash (banknote) rates don't exist** for many currencies (CNY, RUB, AED, …), and SDR has no selling rate.

This server handles all of that, and **always tells the model which bulletin date the numbers come
from**, so the assistant says "as of Friday's bulletin" instead of presenting stale data as today's.

## Tools

| Tool                 | What it does                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `get_exchange_rates` | All ~22 currencies (or a subset) for a date or the latest bulletin                       |
| `convert_currency`   | Any amount between TRY and foreign currencies, or cross rates (EUR→USD) via TRY          |
| `get_rate_history`   | Daily, weekly or monthly series with first/last, min/max (with dates), mean and % change |
| `list_currencies`    | Codes, names and quoting units in the latest bulletin                                    |

Also a **resource** (`tcmb://bulletin/latest`, the raw bulletin as JSON) and a **prompt**
(`fx_briefing`: "brief me on TRY vs USD over the last 30 days").

Every tool is annotated read-only and idempotent, validates its input with zod, and returns both
human-readable text and **structured output** matching a declared `outputSchema`.

### Real output

```text
>>> get_rate_history {"currency":"USD","start_date":"2026-09-14","end_date":"2026-10-13"}
USD forex_buying, daily, 2026-09-14 → 2026-10-13 (22 bulletins):
first 48.5343 · last 49.2794 · change +1.54%
min 48.5343 on 2026-09-14 · max 49.2794 on 2026-10-13 · mean 48.87898

>>> get_exchange_rates {"date":"2026-10-11","currencies":["USD","EUR","GBP"]}
No TCMB bulletin exists for 2026-10-11 (weekend, public holiday, or not yet published - bulletins
appear around 15:30 Istanbul time). Showing the most recent earlier bulletin: 2026/191 of 2026-10-09.

| Code | Currency | Unit | Forex buying | Forex selling | Banknote buying | Banknote selling |
|---|---|---:|---:|---:|---:|---:|
| USD | US DOLLAR | 1 | 49.1274 | 49.2160 | 49.0931 | 49.2898 |
| EUR | EURO | 1 | 55.1112 | 55.2105 | 55.0726 | 55.2933 |
| GBP | POUND STERLING | 1 | 64.9046 | 65.2430 | 64.8592 | 65.3409 |
```

## Install

Requires Node.js 22.12+. No API key needed; TCMB's feed is public.

**Claude Code**

```bash
claude mcp add tcmb -- npx -y github:omergazi34/tcmb-mcp
```

**Claude Desktop / Cursor / other MCP hosts** (`claude_desktop_config.json`, `.cursor/mcp.json`, …)

```json
{
  "mcpServers": {
    "tcmb": {
      "command": "npx",
      "args": ["-y", "github:omergazi34/tcmb-mcp"]
    }
  }
}
```

From source: `npm ci && npm run build`, then point the host at `node /path/to/tcmb-mcp/dist/index.js`.

## How it works

```text
MCP host ──stdio──► server.ts  (tools · resource · prompt, zod schemas, isError on domain errors)
                       │
                       ▼
                   tcmb.ts  TcmbClient
                       ├─ onOrBefore(date): skip weekends locally, walk back over 404s (holidays)
                       ├─ LRU cache: past bulletins forever, "no bulletin" days, latest for 10 min
                       ├─ in-flight de-duplication · bounded concurrency for history
                       └─ timeout + retries (5xx / network only) ──► tcmb.gov.tr/kurlar/YYYYMM/DDMMYYYY.xml
                       │
                   bulletin.ts (XML → typed rates) · convert.ts (via TRY, ÷ unit) · history.ts (stats)
```

Design decisions and trade-offs are in [DESIGN.md](DESIGN.md).

## Development

```bash
npm ci
npm test                 # 39 tests, ~98% line coverage, no network
npm run check            # typecheck + eslint (strict, type-aware) + prettier + tests
TCMB_LIVE=1 npx vitest run test/live.test.ts   # end-to-end over stdio against the real TCMB
```

Unit tests run against a **real bulletin** saved from tcmb.gov.tr (`test/fixtures/13102026.xml`).
A fake TCMB site serves it under any date and returns 404s, 5xx and network errors on demand. MCP
behaviour is tested with the SDK's own `Client` over an in-memory transport. A weekly CI job runs
the built server against the live feed.

## Disclaimer

Not affiliated with TCMB. Rates are TCMB's published indicative rates. For legal, tax or accounting
use, check the official bulletin and the rules that apply to you.

## License

MIT
