/**
 * End-to-end against the real tcmb.gov.tr through the built stdio server, exactly as an MCP host
 * (Claude Desktop, Claude Code, ...) would run it. Skipped unless TCMB_LIVE=1, so normal test runs
 * never depend on the network; a scheduled CI job runs it weekly to catch feed changes.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

describe.skipIf(!process.env.TCMB_LIVE)("live TCMB over stdio", () => {
  const client = new Client({ name: "live-test", version: "1.0.0" });

  beforeAll(async () => {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry] }));
  }, 30_000);

  afterAll(async () => {
    await client.close();
  });

  it("serves the latest bulletin", async () => {
    const result = (await client.callTool({
      name: "get_exchange_rates",
      arguments: { currencies: ["USD", "EUR"] },
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    const data = result.structuredContent as { date: string; rates: { forex_buying: number }[] };
    expect(data.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(data.rates).toHaveLength(2);
    for (const rate of data.rates) expect(rate.forex_buying).toBeGreaterThan(0);
  }, 30_000);

  it("converts using a historical bulletin with weekend fallback", async () => {
    const result = (await client.callTool({
      name: "convert_currency",
      arguments: { amount: 100, from: "EUR", to: "USD", date: "2025-06-01" }, // a Sunday
    })) as CallToolResult;
    expect(result.structuredContent).toMatchObject({
      date: "2025-05-30",
      requested_date: "2025-06-01",
    });
  }, 30_000);
});
