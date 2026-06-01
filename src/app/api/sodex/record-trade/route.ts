/**
 * POST /api/sodex/record-trade
 *
 * Browser-only audit-log endpoint. After the user's browser places an
 * order DIRECTLY at the SoDEX gateway, it POSTs the public outcome
 * here so Helix can show a "live trades" history. We never see the
 * API key secret — we just write down what happened.
 *
 * Unauthenticated by design: anyone with the wallet address can
 * submit, and the table is keyed by wallet. The only abuse vector is
 * a user logging fake trades for their own wallet, which only hurts
 * their own audit view.
 */

import { NextResponse } from "next/server";
import { ExecutedTrades } from "@/lib/db";
import { randomUUID } from "node:crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Body {
  user_wallet?: string;
  signal_id?: string | null;
  network?: "mainnet" | "testnet";
  symbol?: string;
  side?: "buy" | "sell";
  size_usd?: number | null;
  filled_price?: number | null;
  sodex_order_id?: string | null;
  status?: "submitted" | "filled" | "rejected";
  error?: string | null;
}

function isHexAddress(s: unknown): s is string {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
}

export async function POST(req: Request) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }

  if (!isHexAddress(body.user_wallet)) {
    return NextResponse.json(
      { ok: false, error: "user_wallet must be a 0x… address" },
      { status: 400 },
    );
  }
  if (body.network !== "mainnet" && body.network !== "testnet") {
    return NextResponse.json(
      { ok: false, error: "network must be 'mainnet' or 'testnet'" },
      { status: 400 },
    );
  }
  if (!body.symbol || typeof body.symbol !== "string") {
    return NextResponse.json(
      { ok: false, error: "symbol required" },
      { status: 400 },
    );
  }
  if (body.side !== "buy" && body.side !== "sell") {
    return NextResponse.json(
      { ok: false, error: "side must be 'buy' or 'sell'" },
      { status: 400 },
    );
  }
  const status = body.status ?? "submitted";
  if (!["submitted", "filled", "rejected"].includes(status)) {
    return NextResponse.json(
      { ok: false, error: "invalid status" },
      { status: 400 },
    );
  }

  const id = randomUUID();
  await ExecutedTrades.insertExecutedTrade({
    id,
    user_wallet: body.user_wallet,
    signal_id: body.signal_id ?? null,
    network: body.network,
    symbol: body.symbol,
    side: body.side,
    size_usd: body.size_usd ?? null,
    filled_price: body.filled_price ?? null,
    filled_at: Date.now(),
    sodex_order_id: body.sodex_order_id ?? null,
    status: status as "submitted" | "filled" | "rejected",
    error: body.error ?? null,
  });

  return NextResponse.json({ ok: true, id });
}
