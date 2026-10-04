const DEFAULT_BASE_URL = "https://api.tradier.com/v1";
const DEFAULT_STREAM_URL = "https://stream.tradier.com/v1/markets/events";

function token() {
  const value = process.env.TRADIER_TOKEN;
  if (!value) throw new Error("TRADIER_TOKEN is not configured");
  return value;
}

function authHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${token()}`,
    Accept: "application/json",
    ...extra,
  };
}

function compactErrorBody(text) {
  return String(text || "").replace(/\s+/g, " ").slice(0, 800);
}

export async function tradierGet(path, params = {}) {
  const baseUrl = process.env.TRADIER_BASE_URL || DEFAULT_BASE_URL;
  const url = new URL(`${baseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, String(value));
    }
  }
  const response = await fetch(url, {
    method: "GET",
    headers: authHeaders(),
    cache: "no-store",
  });
  if (!response.ok) {
    const body = compactErrorBody(await response.text());
    throw new Error(`Tradier ${response.status} ${response.statusText}: ${body}`);
  }
  return response.json();
}

export async function tradierPost(path, form = {}) {
  const baseUrl = process.env.TRADIER_BASE_URL || DEFAULT_BASE_URL;
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) {
    if (value !== undefined && value !== null && value !== "") {
      body.set(key, String(value));
    }
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/x-www-form-urlencoded" }),
    body,
    cache: "no-store",
  });
  if (!response.ok) {
    const errorBody = compactErrorBody(await response.text());
    throw new Error(`Tradier ${response.status} ${response.statusText}: ${errorBody}`);
  }
  return response.json();
}

export async function getMarketClock() {
  return tradierGet("/markets/clock");
}

export async function getQuotes(symbols, greeks = true) {
  return tradierGet("/markets/quotes", {
    symbols: Array.isArray(symbols) ? symbols.join(",") : symbols,
    greeks,
  });
}

export async function getOptionExpirations(symbol, strikes = false) {
  return tradierGet("/markets/options/expirations", {
    symbol,
    includeAllRoots: false,
    strikes,
    contractSize: true,
    expirationType: true,
  });
}

export async function getOptionChain(symbol, expiration, greeks = true) {
  return tradierGet("/markets/options/chains", {
    symbol,
    expiration,
    greeks,
  });
}

export async function getTimeSales({ symbol, interval = "1min", start, end, sessionFilter = "open" }) {
  return tradierGet("/markets/timesales", {
    symbol,
    interval,
    start,
    end,
    session_filter: sessionFilter,
  });
}

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function unwrapQuotes(payload) {
  return asArray(payload?.quotes?.quote);
}

function unwrapOptions(payload) {
  return asArray(payload?.options?.option);
}

function numeric(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function midAndSpread(quote) {
  const bid = numeric(quote?.bid);
  const ask = numeric(quote?.ask);
  if (bid == null || ask == null || ask < bid) {
    return { mid: null, spread: null, spreadPct: null };
  }
  const mid = (bid + ask) / 2;
  const spread = ask - bid;
  return { mid, spread, spreadPct: mid > 0 ? spread / mid : null };
}

function parseExpirationPayload(payload) {
  const raw = payload?.expirations?.date;
  if (!raw) return [];
  return asArray(raw)
    .map((item) => (typeof item === "string" ? item : item?.date || item?.expiration_date))
    .filter(Boolean)
    .sort();
}

function chooseExpiration(expirations, requested) {
  if (requested) return requested;
  const today = new Date().toISOString().slice(0, 10);
  return expirations.find((date) => date >= today) || expirations[0] || null;
}

export async function buildSignalSnapshot({
  symbol = "SPY",
  expiration,
  strikeRadius = 10,
  maxContracts = 50,
}) {
  const [clock, quotes, expirationsPayload] = await Promise.all([
    getMarketClock(),
    getQuotes(symbol, true),
    getOptionExpirations(symbol, false),
  ]);

  const underlyingQuote = unwrapQuotes(quotes)[0] || null;
  const spot = numeric(underlyingQuote?.last ?? underlyingQuote?.close ?? underlyingQuote?.bid);
  const expirations = parseExpirationPayload(expirationsPayload);
  const selectedExpiration = chooseExpiration(expirations, expiration);

  if (!selectedExpiration) throw new Error(`No option expiration found for ${symbol}`);

  const chainPayload = await getOptionChain(symbol, selectedExpiration, true);
  let contracts = unwrapOptions(chainPayload);

  if (spot != null) {
    contracts = contracts.filter((contract) => {
      const strike = numeric(contract?.strike);
      return strike != null && Math.abs(strike - spot) <= strikeRadius;
    });
  }

  contracts = contracts
    .map((contract) => ({
      symbol: contract.symbol,
      optionType: contract.option_type || contract.type,
      strike: numeric(contract.strike),
      expiration: contract.expiration_date || selectedExpiration,
      bid: numeric(contract.bid),
      ask: numeric(contract.ask),
      last: numeric(contract.last),
      volume: numeric(contract.volume),
      openInterest: numeric(contract.open_interest),
      impliedVolatility: numeric(contract.greeks?.mid_iv ?? contract.greeks?.smv_vol ?? contract.iv),
      greeks: contract.greeks || null,
      ...midAndSpread(contract),
    }))
    .sort((a, b) => {
      const aDist = spot == null || a.strike == null ? Infinity : Math.abs(a.strike - spot);
      const bDist = spot == null || b.strike == null ? Infinity : Math.abs(b.strike - spot);
      return aDist - bDist;
    })
    .slice(0, maxContracts);

  return {
    fetchedAt: new Date().toISOString(),
    symbol,
    market: clock?.clock || clock,
    underlying: underlyingQuote,
    spot,
    expiration: selectedExpiration,
    availableExpirations: expirations.slice(0, 12),
    strikeRadius,
    contracts,
  };
}

export async function sampleMarketStream({
  symbols,
  filters = ["quote", "trade", "timesale"],
  maxEvents = 30,
  timeoutMs = 5000,
}) {
  const session = await tradierPost("/markets/events/session");
  const sessionId = session?.stream?.sessionid || session?.sessionid;
  if (!sessionId) throw new Error("Tradier did not return a market streaming session id");

  const streamUrl = new URL(process.env.TRADIER_STREAM_URL || DEFAULT_STREAM_URL);
  streamUrl.searchParams.set("sessionid", sessionId);
  streamUrl.searchParams.set("symbols", symbols.join(","));
  streamUrl.searchParams.set("filter", filters.join(","));
  streamUrl.searchParams.set("linebreak", "true");
  streamUrl.searchParams.set("validOnly", "true");
  streamUrl.searchParams.set("advancedDetails", "true");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const events = [];

  try {
    const response = await fetch(streamUrl, {
      method: "GET",
      headers: authHeaders(),
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok || !response.body) {
      const body = compactErrorBody(await response.text());
      throw new Error(`Tradier stream ${response.status}: ${body}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (events.length < maxEvents) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          events.push(JSON.parse(trimmed));
        } catch {
          events.push({ raw: trimmed });
        }
        if (events.length >= maxEvents) break;
      }
    }
  } catch (error) {
    if (error?.name !== "AbortError") throw error;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }

  return { sessionId, symbols, filters, timeoutMs, maxEvents, received: events.length, events };
}
