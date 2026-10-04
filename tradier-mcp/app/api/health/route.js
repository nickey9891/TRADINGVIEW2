import { getMarketClock, getQuotes } from "../../../lib/tradier.js";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!process.env.TRADIER_TOKEN) {
    return Response.json(
      { ok: false, configured: false, message: "TRADIER_TOKEN is not configured" },
      { status: 503 },
    );
  }

  try {
    const [clock, quotes] = await Promise.all([getMarketClock(), getQuotes("SPY", true)]);
    return Response.json({
      ok: true,
      configured: true,
      fetchedAt: new Date().toISOString(),
      clock,
      spy: quotes,
    });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        configured: true,
        message: error instanceof Error ? error.message : String(error),
      },
      { status: 502 },
    );
  }
}
