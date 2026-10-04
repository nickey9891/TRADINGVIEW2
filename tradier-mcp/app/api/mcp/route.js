import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import {
  buildSignalSnapshot,
  getMarketClock,
  getOptionChain,
  getOptionExpirations,
  getQuotes,
  getTimeSales,
  sampleMarketStream,
} from "../../../lib/tradier.js";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

function jsonResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function errorResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  return { isError: true, content: [{ type: "text", text: message }] };
}

const mcp = createMcpHandler((server) => {
  server.registerTool(
    "tradier_health",
    {
      title: "Tradier health check",
      description: "Verify the Tradier production token and retrieve current market clock plus a SPY quote.",
      inputSchema: z.object({}),
    },
    async () => {
      try {
        const [clock, quotes] = await Promise.all([getMarketClock(), getQuotes("SPY", true)]);
        return jsonResult({ ok: true, fetchedAt: new Date().toISOString(), clock, quotes });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_quotes",
    {
      title: "Get live quotes",
      description: "Get current Tradier production quotes for stocks or OCC option symbols. Can include option Greeks.",
      inputSchema: z.object({
        symbols: z.array(z.string().min(1)).min(1).max(50),
        greeks: z.boolean().default(true),
      }),
    },
    async ({ symbols, greeks }) => {
      try {
        return jsonResult(await getQuotes(symbols, greeks));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_option_expirations",
    {
      title: "Get option expirations",
      description: "List available option expiration dates for an underlying symbol.",
      inputSchema: z.object({
        symbol: z.string().min(1).default("SPY"),
        includeStrikes: z.boolean().default(false),
      }),
    },
    async ({ symbol, includeStrikes }) => {
      try {
        return jsonResult(await getOptionExpirations(symbol.toUpperCase(), includeStrikes));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_option_chain",
    {
      title: "Get live option chain",
      description: "Get a Tradier production option chain for one underlying and expiration, including quotes and optional Greeks.",
      inputSchema: z.object({
        symbol: z.string().min(1).default("SPY"),
        expiration: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        greeks: z.boolean().default(true),
      }),
    },
    async ({ symbol, expiration, greeks }) => {
      try {
        return jsonResult(await getOptionChain(symbol.toUpperCase(), expiration, greeks));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_time_sales",
    {
      title: "Get intraday time and sales",
      description: "Get Tradier tick or 1/5/15-minute time-and-sales data for a stock or unexpired option symbol.",
      inputSchema: z.object({
        symbol: z.string().min(1),
        interval: z.enum(["tick", "1min", "5min", "15min"]).default("1min"),
        start: z.string().optional(),
        end: z.string().optional(),
        sessionFilter: z.enum(["open", "all"]).default("open"),
      }),
    },
    async (args) => {
      try {
        return jsonResult(await getTimeSales(args));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "sample_market_stream",
    {
      title: "Sample live market stream",
      description: "Open Tradier's live production stream briefly and return quote/trade/time-sale events for the requested symbols.",
      inputSchema: z.object({
        symbols: z.array(z.string().min(1)).min(1).max(25),
        filters: z.array(z.enum(["quote", "trade", "summary", "timesale", "tradex"]))
          .min(1)
          .default(["quote", "trade", "timesale"]),
        maxEvents: z.number().int().min(1).max(100).default(30),
        timeoutMs: z.number().int().min(1000).max(15000).default(5000),
      }),
    },
    async ({ symbols, filters, maxEvents, timeoutMs }) => {
      try {
        return jsonResult(await sampleMarketStream({ symbols, filters, maxEvents, timeoutMs }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_signal_snapshot",
    {
      title: "Get compact options signal snapshot",
      description: "Return a compact live snapshot for signal generation: market clock, underlying quote, nearest or requested expiration, and nearby options with IV, Greeks, bid/ask, spread and liquidity fields.",
      inputSchema: z.object({
        symbol: z.string().min(1).default("SPY"),
        expiration: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        strikeRadius: z.number().positive().max(100).default(10),
        maxContracts: z.number().int().min(4).max(100).default(50),
      }),
    },
    async ({ symbol, expiration, strikeRadius, maxContracts }) => {
      try {
        return jsonResult(await buildSignalSnapshot({
          symbol: symbol.toUpperCase(),
          expiration,
          strikeRadius,
          maxContracts,
        }));
      } catch (error) {
        return errorResult(error);
      }
    },
  );
});

async function secured(request) {
  const accessKey = process.env.MCP_ACCESS_KEY;
  if (accessKey) {
    const expected = `Bearer ${accessKey}`;
    if (request.headers.get("authorization") !== expected) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: {
          "content-type": "application/json",
          "www-authenticate": "Bearer",
        },
      });
    }
  }
  return mcp(request);
}

export { secured as GET, secured as POST };
