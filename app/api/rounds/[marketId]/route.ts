// GET /api/rounds/:marketId → a single Round (fresh read, for live card updates)
import { NextRequest, NextResponse } from "next/server";
import { getRound } from "../../../../lib/somnia/rounds";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: { marketId: string } }) {
  try {
    const round = await getRound(params.marketId);
    return NextResponse.json({ round });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Not found" }, { status: 404 });
  }
}
