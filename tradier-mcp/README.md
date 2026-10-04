# Tradier Options MCP

Read-only MCP bridge for Tradier Brokerage production market data, designed for live SPY/QQQ options analysis in ChatGPT.

## What it exposes

- `tradier_health` — validates production access and returns market clock + SPY quote.
- `get_quotes` — live stock or OCC option quotes, optionally including Greeks.
- `get_option_expirations` — available expirations.
- `get_option_chain` — live option chain for an expiration.
- `get_time_sales` — tick or 1/5/15-minute time-and-sales data.
- `sample_market_stream` — short sample from Tradier's live streaming feed.
- `get_signal_snapshot` — compact SPY/QQQ snapshot with underlying quote, nearest expiration, nearby contracts, IV/Greeks, bid/ask, spread and liquidity fields.

## Security

**Never commit a Tradier production token.** Store it only as a deployment secret/environment variable.

Required environment variable:

```text
TRADIER_TOKEN=<your production token>
```

Optional variables:

```text
TRADIER_BASE_URL=https://api.tradier.com/v1
TRADIER_STREAM_URL=https://stream.tradier.com/v1/markets/events
MCP_ACCESS_KEY=<long random secret>
```

If `MCP_ACCESS_KEY` is configured, clients must send `Authorization: Bearer <MCP_ACCESS_KEY>` to `/api/mcp`.

## Vercel deployment

Set the project root directory to `tradier-mcp`, deploy, then add `TRADIER_TOKEN` as a Production/Preview environment variable in Vercel. Redeploy after adding the secret.

Health check:

```text
https://<deployment>/api/health
```

MCP endpoint:

```text
https://<deployment>/api/mcp
```

## Tradier behavior

The code intentionally uses the production base URL. Tradier production accounts provide real-time market data; sandbox market data is delayed. Option-chain responses can include ORATS Greek/IV fields. Streaming uses a short-lived market session and the `stream.tradier.com` endpoint.

## Scope

This server is deliberately **read-only**. It contains no account-balance, position, order-entry, order-cancel, or trading tools. That separation is intentional for the signal-calling workflow.
