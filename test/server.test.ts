import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { bulletinXml, makeClient } from "./helpers.js";

const days = ["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13"];
const usd = [48.9, 49.1, 49.0, 49.3, 49.2, 49.2794];

/** A real MCP client talking to the server over an in-memory transport. */
async function connect() {
  const fake = makeClient(Object.fromEntries(days.map((d, i) => [d, bulletinXml(d, usd[i])])));
  const server = createServer(fake.client);
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    (await client.callTool({ name, arguments: args })) as CallToolResult;
  return { client, call, calls: fake.calls };
}

function text(result: CallToolResult): string {
  const [first] = result.content;
  return first?.type === "text" ? first.text : "";
}

describe("MCP server", () => {
  it("advertises read-only tools with input and output schemas", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "convert_currency",
      "get_exchange_rates",
      "get_rate_history",
      "list_currencies",
    ]);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.outputSchema).toBeDefined();
    }
    expect(client.getInstructions()).toMatch(/15:30 Istanbul time/);
  });

  it("get_exchange_rates filters currencies and returns structured data", async () => {
    const { call } = await connect();
    const result = await call("get_exchange_rates", { currencies: ["usd", "JPY"] });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      date: "2026-10-13",
      bulletin_no: "2026/193",
      rates: [
        { code: "USD", forex_buying: 49.2794 },
        { code: "JPY", unit: 100 },
      ],
    });
    expect(text(result)).toContain("| USD | US DOLLAR | 1 | 49.2794 |");
  });

  it("tells the model when it falls back to an earlier bulletin", async () => {
    const { call } = await connect();
    const result = await call("get_exchange_rates", { date: "2026-10-11", currencies: ["EUR"] });
    expect(result.structuredContent).toMatchObject({
      requested_date: "2026-10-11",
      date: "2026-10-09",
    });
    expect(text(result)).toMatch(/No TCMB bulletin exists for 2026-10-11/);
  });

  it("convert_currency handles TRY, cross rates and quoting units", async () => {
    const { call } = await connect();
    const usdTry = await call("convert_currency", { amount: 100, from: "USD", to: "TRY" });
    expect(usdTry.structuredContent).toMatchObject({ result: 4927.94, rate_type: "forex_buying" });
    expect(text(usdTry)).toContain("100.00 USD = 4927.94 TRY");

    const jpy = await call("convert_currency", { amount: 1000, from: "JPY", to: "TRY" });
    expect((jpy.structuredContent as { result: number }).result).toBeCloseTo(310.945, 6);

    const old = await call("convert_currency", {
      amount: 1,
      from: "USD",
      to: "TRY",
      date: "2026-10-07",
      rate_type: "forex_buying",
    });
    expect(old.structuredContent).toMatchObject({ result: 49.1, date: "2026-10-07" });
  });

  it("returns recoverable errors as tool results", async () => {
    const { call } = await connect();
    const unknown = await call("convert_currency", { amount: 1, from: "BTC", to: "TRY" });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toMatch(/unknown currency "BTC"/);

    const future = await call("get_exchange_rates", { date: "2030-01-01" });
    expect(future.isError).toBe(true);
    expect(text(future)).toMatch(/in the future/);

    const noCash = await call("convert_currency", {
      amount: 1,
      from: "CNY",
      to: "TRY",
      rate_type: "banknote_buying",
    });
    expect(text(noCash)).toMatch(/does not publish a banknote buying rate for CNY/);

    const badCode = await call("get_exchange_rates", { currencies: ["DOGE"] });
    expect(badCode.isError).toBe(true);
  });

  it("rejects invalid arguments before doing any work", async () => {
    const { call, calls } = await connect();
    const result = await call("convert_currency", { amount: -5, from: "USD", to: "TRY" });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/Input validation error/);
    expect(calls).toHaveLength(0);
  });

  it("get_rate_history returns points and statistics", async () => {
    const { call } = await connect();
    const result = await call("get_rate_history", {
      currency: "USD",
      start_date: "2026-10-06",
      end_date: "2026-10-13",
    });
    const data = result.structuredContent as {
      points: { date: string; rate: number }[];
      stats: { min: { date: string }; max: { date: string }; change_pct: number };
    };
    expect(data.points.map((p) => p.date)).toEqual(days);
    expect(data.stats.min.date).toBe("2026-10-06");
    expect(data.stats.max.date).toBe("2026-10-09");
    expect(data.stats.change_pct).toBeCloseTo(((49.2794 - 48.9) / 48.9) * 100, 6);
    expect(text(result)).toMatch(
      /USD forex_buying, daily, 2026-10-06 → 2026-10-13 \(6 bulletins\)/,
    );
  });

  it("get_rate_history enforces range limits", async () => {
    const { call, calls } = await connect();
    const result = await call("get_rate_history", { currency: "USD", start_date: "2026-01-01" });
    expect(result.isError).toBe(true);
    expect(text(result)).toMatch(/daily history is limited to 93 days/);
    expect(calls).toHaveLength(0);
  });

  it("list_currencies, the bulletin resource and the briefing prompt work", async () => {
    const { client, call } = await connect();
    const list = await call("list_currencies");
    expect(text(list)).toContain("JPY  JAPENESE YEN (quoted per 100)");

    const resource = await client.readResource({ uri: "tcmb://bulletin/latest" });
    const [content] = resource.contents;
    expect(content && "text" in content ? JSON.parse(content.text) : null).toMatchObject({
      date: "2026-10-13",
    });

    const prompt = await client.getPrompt({ name: "fx_briefing", arguments: { currency: "EUR" } });
    const [message] = prompt.messages;
    expect(message?.content.type === "text" ? message.content.text : "").toMatch(/TRY against EUR/);
  });
});
