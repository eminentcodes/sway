// POST /api/result → record a settled bet. Body: ResultReport.
// Idempotent on (wallet, marketId) so the client can safely re-report.
import { NextRequest, NextResponse } from "next/server";
import { recordResult } from "../../../lib/db";
import { ResultReport, Side } from "../../../lib/types";

export const dynamic = "force-dynamic";

function isSide(s: any): s is Side {
  return s === "UP" || s === "DOWN";
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON" }, { status: 400 });
  }

  // Validate — never trust the client. Wallet + market + side + numeric stake required.
  if (
    typeof body?.wallet !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(body.wallet) ||
    typeof body?.marketId !== "string" ||
    !isSide(body?.side) ||
    typeof body?.stake !== "number" ||
    !(body.stake >= 0) ||
    typeof body?.won !== "boolean"
  ) {
    return NextResponse.json({ ok: false, error: "Malformed result report" }, { status: 400 });
  }

  const report: ResultReport = {
    wallet: body.wallet,
    marketId: body.marketId,
    side: body.side,
    stake: body.stake,
    won: body.won,
    payout: typeof body.payout === "number" && body.payout >= 0 ? body.payout : undefined,
  };

  const recorded = recordResult(report);
  return NextResponse.json({ ok: true, recorded });
}
