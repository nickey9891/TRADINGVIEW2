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
  tradierGet,
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
  server.registerTool(
    "get_daily_history",
    {
      title: "Get historical daily prices",
      description: "Retrieve Tradier daily OHLCV bars for an explicit date range to research 6- and 12-month trends. Returns all available bars without truncation. Adjustment status is unverified; do not assume dividend-adjusted total returns. Request at least 12 months of warm-up before the backtest period.",
      inputSchema: z.object({
        symbol: z.string().trim().min(1).max(32).regex(/^[A-Za-z0-9.^_-]+$/),
        start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ symbol, start, end }) => {
      try {
        for (const date of [start, end]) {
          const parsed = new Date(date + "T00:00:00Z");
          if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
            throw new Error("Dates must be valid calendar dates in YYYY-MM-DD format");
          }
        }
        if (start > end) throw new Error("start must be on or before end");
        const normalizedSymbol = symbol.trim().toUpperCase();
        const payload = await tradierGet("/markets/history", {
          symbol: normalizedSymbol, interval: "daily", start, end,
        });
        const raw = payload?.history?.day;
        const bars = (raw == null ? [] : Array.isArray(raw) ? raw : [raw])
          .slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
        if (!bars.length) throw new Error("Tradier returned no daily bars for this symbol and date range");
        if (bars.some((bar) => !bar.date || bar.date < start || bar.date > end ||
          ["open", "high", "low", "close", "volume"].some((key) =>
            bar[key] == null || !Number.isFinite(Number(bar[key]))))) {
          throw new Error("Tradier returned invalid or out-of-range daily bars");
        }
        return jsonResult({
          source: "Tradier", symbol: normalizedSymbol, interval: "daily",
          requestedStart: start, requestedEnd: end,
          fetchedAt: new Date().toISOString(), count: bars.length,
          firstDate: bars[0].date, lastDate: bars[bars.length - 1].date,
          adjustmentStatus: "unverified",
          notes: [
            "OHLCV values are returned as supplied by Tradier; no total-return adjustment is applied here.",
            "Coverage is limited to the returned firstDate and lastDate; missing history is not fabricated.",
            "The most recent daily bar may be incomplete during the trading session.",
          ],
          bars,
        });
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
