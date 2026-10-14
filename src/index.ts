#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

const server = createServer();
await server.connect(new StdioServerTransport());
// stdout carries the protocol; diagnostics must go to stderr.
console.error("tcmb-mcp: ready on stdio");
