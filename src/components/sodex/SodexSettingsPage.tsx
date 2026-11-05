"use client";

/**
 * /settings/sodex — "Manage keys". Replaces the old Connect SoDEX page. Setup
 * happens entirely in the global SodexAuth modal (header "Connect"); this page
 * is just the standing management surface: the registered-key list (with Helix
 * / external / expired badges + Revoke), "Generate new key", and the builder-
 * fee status with Re-approve. No balances (Portfolio covers those), no safety
 * limits, no "ready to execute" banners.
 */

import { useCallback, useEffect, useState } from "react";
import { cn } from "@/components/ui/cn";
import { Button } from "@/components/ui/Button";
import { listApiKeys } from "@/lib/sodex-onchain/client";
import { getBuilderCode } from "@/lib/sodex-onchain/chains";
import {
  expiryFromTimestamp,
  formatExpiry,
} from "@/lib/sodex-onchain/local-keys";
import { isHelixManagedKey } from "@/lib/sodex-onchain/key-roles";
import type { SodexApiKeyRow } from "@/lib/sodex-onchain/types";
import { useSodexAuth } from "./auth/SodexAuthProvider";

export function SodexSettingsPage() {
  const a = useSodexAuth();
  const [keys, setKeys] = useState<SodexApiKeyRow[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(false);
  const fee = getBuilderCode("mainnet")?.fee ?? 10;

  const loadKeys = useCallback(async () => {
    if (!a.address) {
      setKeys([]);
      return;
    }
    setLoadingKeys(true);
    try {
      setKeys(await listApiKeys("mainnet", a.address));
    } catch {
      /* keep last */
    } finally {
      setLoadingKeys(false);
    }
  }, [a.address]);

  useEffect(() => {
    loadKeys();
  }, [loadKeys, a.key]);

  return (
    <div className="trade-terminal flex flex-col gap-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-fg">Manage keys</h1>
        <p className="text-[13px] text-fg-muted">
          Your SoDEX trading keys and Helix&apos;s builder-fee approval. The
          trading key&apos;s secret lives only in this browser — your master
          wallet signs once, and you can revoke any time.
        </p>
      </header>

      {!a.isConnected ? (
        <Card>
          <p className="text-[13px] text-fg-muted">
            Connect your wallet to manage keys.
          </p>
          <Button onClick={() => a.openSetup()} className="mt-3">
            Connect
          </Button>
        </Card>
      ) : (
        <>
          {/* Keys */}
          <Card>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-[14px] font-semibold text-fg">Trading keys</h2>
              <button
                onClick={a.generateKey}
                disabled={a.busy === "key" || !a.hasAccount}
                className="rounded-md border border-[color:var(--accent-trade)]/50 bg-[color:var(--accent-trade)]/15 px-3 py-1.5 text-[12px] font-semibold text-[color:var(--accent-trade)] hover:bg-[color:var(--accent-trade)]/25 disabled:opacity-50"
              >
                {a.busy === "key" ? "Creating…" : "Generate new key"}
              </button>
            </div>
            {a.error ? (
              <p className="mb-2 text-[11.5px] text-negative">{a.error}</p>
            ) : null}
            {keys.length === 0 ? (
              <p className="text-[12px] text-fg-dim">
                {loadingKeys ? "Loading…" : "No registered keys."}
              </p>
            ) : (
              <div className="flex flex-col divide-y divide-line">
                {keys.map((k) => {
                  const exp = expiryFromTimestamp(k.expiresAt);
                  const helix = isHelixManagedKey(k.name);
                  const isActive = a.key?.name === k.name;
                  return (
                    <div
                      key={k.name}
                      className="flex items-center justify-between gap-3 py-2.5"
                    >
                      <div className="flex min-w-0 flex-col">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-[var(--font-jetbrains-mono)] text-[12px] text-fg">
                            {k.name || "(burner)"}
                          </span>
                          <Badge tone={helix ? "accent" : "muted"}>
                            {helix ? "Helix" : "external"}
                          </Badge>
                          {exp.state === "expired" ? (
                            <Badge tone="negative">expired</Badge>
                          ) : exp.state === "expiring" ? (
                            <Badge tone="warn">expiring</Badge>
                          ) : null}
                          {isActive ? (
                            <Badge tone="positive">active</Badge>
                          ) : null}
                        </div>
                        <span className="text-[10.5px] text-fg-dim">
                          {formatExpiry(exp) || "no expiry"}
                        </span>
                      </div>
                      <button
                        onClick={() => a.revokeKey(k.name)}
                        disabled={a.busy === `revoke:${k.name}`}
                        className="shrink-0 rounded border border-line px-2.5 py-1 text-[11px] text-fg-muted hover:border-negative/50 hover:text-negative disabled:opacity-50"
                      >
                        {a.busy === `revoke:${k.name}` ? "Revoking…" : "Revoke"}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <p className="mt-3 text-[10.5px] text-fg-dim">
              SoDEX allows up to 5 keys per account. At the cap, revoke an old
              one before generating a new key.
            </p>
          </Card>

          {/* Builder fee */}
          <Card>
            <div className="flex items-center justify-between">
              <div className="flex flex-col">
                <h2 className="text-[14px] font-semibold text-fg">Builder fee</h2>
                <span className="text-[11.5px] text-fg-muted">
                  Helix&apos;s {(fee / 1000).toFixed(2)}% fee on your routed
                  trades (one signature).
                </span>
              </div>
              <div className="flex items-center gap-2">
                {a.builderApproved ? (
                  <span className="text-[12px] text-positive">✓ Approved</span>
                ) : null}
                <button
                  onClick={a.approveBuilder}
                  disabled={a.busy === "builder"}
                  className={cn(
                    "rounded-md border px-3 py-1.5 text-[12px] font-medium disabled:opacity-50",
                    a.builderApproved
                      ? "border-line text-fg-muted hover:text-fg"
                      : "border-[color:var(--accent-trade)]/50 bg-[color:var(--accent-trade)]/15 text-[color:var(--accent-trade)]",
                  )}
                >
                  {a.busy === "builder"
                    ? "Approving…"
                    : a.builderApproved
                      ? "Re-approve"
                      : "Approve"}
                </button>
              </div>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4">{children}</div>
  );
}

function Badge({
  tone,
  children,
}: {
  tone: "accent" | "muted" | "negative" | "warn" | "positive";
  children: React.ReactNode;
}) {
  const cls = {
    accent: "text-[color:var(--accent-trade)] border-[color:var(--accent-trade)]/40",
    muted: "text-fg-dim border-line",
    negative: "text-negative border-negative/40",
    warn: "text-[#e0a53f] border-[#e0a53f]/40",
    positive: "text-positive border-positive/40",
  }[tone];
  return (
    <span
      className={cn(
        "rounded border px-1.5 py-px text-[9px] font-medium uppercase tracking-wider",
        cls,
      )}
    >
      {children}
    </span>
  );
}
