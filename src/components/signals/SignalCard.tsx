"use client";

import { useState } from "react";
import Link from "next/link";
import {
  fmtAssetSymbol,
  fmtRelative,
  fmtSodexSymbol,
  fmtUsd,
  truncate,
} from "@/lib/format";
import { stripTechnicalScoring } from "@/lib/format/reasoning";
import { cn } from "@/components/ui/cn";

const TEXT_BRAND = "#ede4d3";
const TEXT_MUTED = "#8a857a";
const TEXT_DIM = "#5d584e";
const ACCENT = "#d97757";
const POSITIVE = "#5cc97a";
const NEGATIVE = "#e06c66";
const WARNING = "#d1a85a";
const BORDER_QUIET = "rgba(237, 228, 211, 0.08)";

const tierColor = {
  auto: ACCENT,
  review: "#7fa9d1",
  info: TEXT_DIM,
};

export interface SignalCardData {
  id: string;
  fired_at: number;
  asset_id: string;
  sodex_symbol: string;
  direction: "long" | "short";
  tier: "auto" | "review" | "info";
  status: "pending" | "executed" | "dismissed" | "expired";
  confidence: number;
  expected_horizon: string | null;
  suggested_size_usd: number | null;
  suggested_stop_pct: number | null;
  suggested_target_pct: number | null;
  reasoning: string;
  asset_symbol: string;
  asset_name: string;
  asset_kind: string;
  event_title: string | null;
  event_release_time: number | null;
  event_source_link?: string | null;
  event_original_link?: string | null;
  /** True when another pending signal disagrees on direction for this asset. */
  has_conflict?: boolean;
  // ── Pipeline metadata (nullable on legacy rows pre-pipeline-wiring) ──
  catalyst_subtype?: string | null;
  expires_at?: number | null;
  corroboration_deadline?: number | null;
  event_chain_id?: string | null;
  asset_relevance?: number | null;
  promotional_score?: number | null;
  source_tier?: number | null;
  dismiss_reason?: string | null;
}

/** Format ms-from-now as a compact "in 4h" / "in 2d" / "expired" string. */
function fmtTtl(expiresAt: number | null | undefined): string | null {
  if (expiresAt == null) return null;
  const ms = expiresAt - Date.now();
  if (ms <= 0) return "expired";
  const h = Math.round(ms / 3600 / 1000);
  if (h < 1) return `<1h`;
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** Pretty-print a catalyst subtype for the UI. */
function fmtSubtype(subtype: string | null | undefined): string | null {
  if (!subtype || subtype === "other") return null;
  return subtype.replace(/_/g, " ");
}

/** Tone for the asset-relevance badge. */
function relevanceTone(
  relevance: number | null | undefined,
): "positive" | "info" | "default" | "warning" {
  if (relevance == null) return "default";
  if (relevance >= 0.95) return "positive"; // subject
  if (relevance >= 0.75) return "info"; // directly_affected
  if (relevance >= 0.45) return "default"; // basket_with_member
  return "warning"; // incidentally_mentioned
}

/** Human label for a relevance score. */
function relevanceLabel(relevance: number | null | undefined): string {
  if (relevance == null) return "—";
  if (relevance >= 0.95) return "subject";
  if (relevance >= 0.75) return "directly affected";
  if (relevance >= 0.45) return "basket member";
  if (relevance >= 0.25) return "incidental";
  return "weak";
}

/**
 * Extract the first sentence of a passage. Used as a one-line summary
 * with a "Read more" toggle. Falls back to a soft char limit if the
 * sentence boundary isn't found.
 */
function firstSentence(text: string): string {
  const trimmed = text.trim();
  // Match sentence-ending punctuation followed by whitespace or end.
  const match = trimmed.match(/^[\s\S]*?[.!?](?=\s|$)/);
  if (match) return match[0].trim();
  // No punctuation — soft-truncate at 160 chars on a word boundary.
  if (trimmed.length <= 160) return trimmed;
  const slice = trimmed.slice(0, 160);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > 100 ? slice.slice(0, lastSpace) : slice) + "…";
}

/** Format a ms timestamp as "8 May 2026, 21:30 UTC". */
function fmtFullDate(ts: number): string {
  const d = new Date(ts);
  const day = d.getUTCDate();
  const month = d.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  const year = d.getUTCFullYear();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day} ${month} ${year}, ${hh}:${mm} UTC`;
}

const tierLabel = {
  auto: "AUTO",
  review: "REVIEW",
  info: "INFO",
};

const directionLabel = {
  long: "LONG",
  short: "SHORT",
};

function ParamCell({
  label,
  value,
  tone = "neutral",
  title,
}: {
  label: string;
  value: string;
  tone?: "positive" | "negative" | "warning" | "neutral";
  title?: string;
}) {
  const color =
    tone === "positive"
      ? POSITIVE
      : tone === "negative"
        ? NEGATIVE
        : tone === "warning"
          ? WARNING
          : TEXT_BRAND;
  return (
    <div className="flex flex-col gap-1" title={title}>
      <div
        className="font-[var(--font-jetbrains-mono)] uppercase"
        style={{
          fontSize: "9px",
          fontWeight: 500,
          letterSpacing: "0.14em",
          color: TEXT_DIM,
        }}
      >
        {label}
      </div>
      <div
        className="font-[var(--font-jetbrains-mono)] tabular-nums"
        style={{ fontSize: "13px", color, lineHeight: 1.15 }}
      >
        {value}
      </div>
    </div>
  );
}

export function SignalCard({
  sig,
  onAction,
}: {
  sig: SignalCardData;
  onAction?: () => void;
}) {
  const [busy, setBusy] = useState<"executing" | "dismissing" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [sizeInput, setSizeInput] = useState<string>(
    sig.suggested_size_usd != null
      ? sig.suggested_size_usd.toFixed(2)
      : "350.00",
  );
  const [stopInput, setStopInput] = useState<string>(
    sig.suggested_stop_pct != null ? String(sig.suggested_stop_pct) : "3",
  );
  const [targetInput, setTargetInput] = useState<string>(
    sig.suggested_target_pct != null ? String(sig.suggested_target_pct) : "5",
  );

  const post = async (
    path: string,
    body: Record<string, unknown> = {},
  ) => {
    setError(null);
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signal_id: sig.id, ...body }),
    });
    const data = await res.json();
    if (!data.ok) {
      setError(data.error ?? "request failed");
      return false;
    }
    return true;
  };

  const onConfirmExecute = async () => {
    const size_usd = Number.parseFloat(sizeInput);
    const stop_pct = Number.parseFloat(stopInput);
    const target_pct = Number.parseFloat(targetInput);
    if (!Number.isFinite(size_usd) || size_usd <= 0) {
      setError("size must be > 0");
      return;
    }
    if (!Number.isFinite(stop_pct) || stop_pct <= 0 || stop_pct >= 100) {
      setError("stop must be between 0 and 100");
      return;
    }
    if (!Number.isFinite(target_pct) || target_pct <= 0) {
      setError("target must be > 0");
      return;
    }
    setBusy("executing");
    const ok = await post("/api/trading/execute", {
      size_usd,
      stop_pct,
      target_pct,
    });
    setBusy(null);
    if (ok) {
      setBuilding(false);
      onAction?.();
    }
  };

  const onDismiss = async () => {
    setBusy("dismissing");
    const ok = await post("/api/trading/dismiss");
    setBusy(null);
    if (ok) onAction?.();
  };

  const isPending = sig.status === "pending";
  const isInfoOnly = sig.tier === "info";
  const dirIsLong = sig.direction === "long";
  const directionColor = dirIsLong ? POSITIVE : NEGATIVE;
  const ttl = fmtTtl(sig.expires_at);
  // Venue–direction guard: shorts can only be filled on perp. If a legacy
  // pending signal carries a spot symbol with direction=short, block Execute.
  const isPerp = sig.sodex_symbol.includes("-USD");
  const venueBlocksExecute = !dirIsLong && !isPerp;

  const dateLine = sig.event_release_time
    ? fmtFullDate(sig.event_release_time)
    : `Signal fired ${fmtRelative(sig.fired_at)}`;

  return (
    <article
      className={cn(
        "group relative flex flex-col py-6",
        sig.status === "executed" && "opacity-60",
        sig.status === "dismissed" && "opacity-45",
      )}
      style={{
        borderTop: `1px solid ${BORDER_QUIET}`,
        paddingLeft: "26px",
        paddingRight: "26px",
      }}
    >
      {/* Tier accent — soft vertical hairline on the left */}
      <span
        aria-hidden
        style={{
          position: "absolute",
          left: 0,
          top: "22px",
          bottom: "22px",
          width: "2px",
          background: tierColor[sig.tier],
          opacity: 0.85,
        }}
      />

      {/* Kicker line — ticker + direction + tier. One quiet line. */}
      <div className="mb-3 flex items-baseline gap-x-3">
        <span
          className="font-[var(--font-jetbrains-mono)]"
          style={{
            fontSize: "12px",
            fontWeight: 600,
            color: TEXT_BRAND,
            letterSpacing: "0.04em",
          }}
        >
          {fmtAssetSymbol(sig.asset_symbol, sig.asset_kind)}
        </span>
        <span style={{ color: TEXT_DIM, fontSize: "11px" }}>·</span>
        <span
          className="font-[var(--font-jetbrains-mono)] uppercase"
          style={{
            fontSize: "10px",
            fontWeight: 600,
            letterSpacing: "0.22em",
            color: directionColor,
          }}
        >
          {directionLabel[sig.direction]}
        </span>
        <span style={{ color: TEXT_DIM, fontSize: "11px" }}>·</span>
        <span
          className="font-[var(--font-jetbrains-mono)] uppercase"
          style={{
            fontSize: "10px",
            letterSpacing: "0.22em",
            color: tierColor[sig.tier],
          }}
        >
          {tierLabel[sig.tier]}
        </span>
        <span
          className="font-[var(--font-jetbrains-mono)] uppercase"
          style={{
            fontSize: "9px",
            fontWeight: 600,
            letterSpacing: "0.2em",
            color: TEXT_MUTED,
            border: `1px solid ${BORDER_QUIET}`,
            borderRadius: "2px",
            padding: "2px 7px",
            marginLeft: "4px",
            lineHeight: 1,
          }}
        >
          {sig.sodex_symbol.includes("-USD") ? "PERP" : "SPOT"}
        </span>
        {sig.status !== "pending" ? (
          <>
            <span style={{ color: TEXT_DIM, fontSize: "11px" }}>·</span>
            <span
              className="font-[var(--font-jetbrains-mono)] uppercase"
              style={{
                fontSize: "10px",
                letterSpacing: "0.22em",
                color:
                  sig.status === "executed"
                    ? POSITIVE
                    : sig.status === "expired"
                      ? WARNING
                      : TEXT_DIM,
              }}
            >
              {sig.status}
            </span>
          </>
        ) : null}
        {sig.has_conflict ? (
          <>
            <span style={{ color: TEXT_DIM, fontSize: "11px" }}>·</span>
            <span
              className="font-[var(--font-jetbrains-mono)] uppercase animate-pulse"
              style={{
                fontSize: "10px",
                letterSpacing: "0.22em",
                color: WARNING,
              }}
            >
              CONFLICT
            </span>
          </>
        ) : null}
        <Link
          href={`/signal/${sig.id}`}
          className="ml-auto font-[var(--font-jetbrains-mono)] transition-opacity hover:opacity-100"
          style={{
            fontSize: "10px",
            letterSpacing: "0.18em",
            color: TEXT_DIM,
            opacity: 0.7,
          }}
          title="Open full audit trail"
        >
          AUDIT →
        </Link>
      </div>

      {/* Headline — the news. Editorial Fraunces. Clickable to source article. */}
      {sig.event_title ? (() => {
        const href = sig.event_source_link ?? sig.event_original_link ?? null;
        const headlineStyle = {
          fontSize: "18px",
          fontWeight: 400,
          lineHeight: 1.3,
          letterSpacing: "-0.012em",
          color: TEXT_BRAND,
          marginBottom: "10px",
          maxWidth: "70ch",
          display: "inline-block",
          textDecoration: "none",
        } as const;
        const text = truncate(sig.event_title, 140);
        return href ? (
          <h3 style={{ marginBottom: "10px" }}>
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="font-[var(--font-fraunces)] signal-headline-link"
              style={headlineStyle}
              title="Open source article on SoSoValue"
            >
              {text}
            </a>
          </h3>
        ) : (
          <h3
            className="font-[var(--font-fraunces)]"
            style={headlineStyle}
          >
            {text}
          </h3>
        );
      })() : null}

      {/* Byline — newspaper-style dateline directly under the headline. */}
      <div
        className="font-[var(--font-inter)] tabular-nums"
        style={{
          fontSize: "12px",
          letterSpacing: "0.01em",
          color: TEXT_MUTED,
          marginBottom: "14px",
          fontWeight: 400,
        }}
      >
        {dateLine}
      </div>

      {/* Reasoning — one-sentence summary with optional expand. */}
      {(() => {
        const full = stripTechnicalScoring(sig.reasoning.trim());
        const summary = firstSentence(full);
        const hasMore = summary.length < full.length;
        return (
          <p
            className="font-[var(--font-inter)]"
            style={{
              fontSize: "12.5px",
              lineHeight: 1.6,
              color: TEXT_MUTED,
              marginBottom: "14px",
              maxWidth: "70ch",
              fontWeight: 400,
            }}
          >
            {expanded ? full : summary}
            {hasMore ? (
              <>
                {" "}
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  className="font-[var(--font-jetbrains-mono)] transition-colors"
                  style={{
                    fontSize: "10px",
                    letterSpacing: "0.14em",
                    color: TEXT_DIM,
                    background: "transparent",
                    border: "none",
                    padding: 0,
                    cursor: "pointer",
                    textTransform: "uppercase",
                    verticalAlign: "baseline",
                  }}
                  onMouseEnter={(e) =>
                    (e.currentTarget.style.color = ACCENT)
                  }
                  onMouseLeave={(e) =>
                    (e.currentTarget.style.color = TEXT_DIM)
                  }
                >
                  {expanded ? "Show less ↑" : "Read more →"}
                </button>
              </>
            ) : null}
          </p>
        );
      })()}

      {/* Trade line — values prominent, labels beneath */}
      <div
        className="flex flex-wrap items-start"
        style={{ columnGap: "32px", rowGap: "12px", marginBottom: "4px" }}
      >
        <TradeFigure
          value={fmtUsd(sig.suggested_size_usd)}
          label="Size"
        />
        <TradeFigure
          value={
            sig.suggested_stop_pct != null
              ? `−${sig.suggested_stop_pct}%`
              : "—"
          }
          label="Stop"
          tone={sig.suggested_stop_pct != null ? "negative" : "neutral"}
        />
        <TradeFigure
          value={
            sig.suggested_target_pct != null
              ? `+${sig.suggested_target_pct}%`
              : "—"
          }
          label="Target"
          tone={sig.suggested_target_pct != null ? "positive" : "neutral"}
        />
        <TradeFigure
          value={sig.expected_horizon ?? "—"}
          label="Horizon"
        />
        {ttl ? (
          <TradeFigure
            value={ttl}
            label="Expires"
            tone={ttl === "expired" ? "warning" : "neutral"}
          />
        ) : null}
      </div>


      {/* Actions */}
      {isPending && !isInfoOnly && !building ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            onClick={() => {
              setError(null);
              setBuilding(true);
            }}
            disabled={busy !== null || venueBlocksExecute}
            title={
              venueBlocksExecute
                ? "Shorts must be filled on a perp market. This asset has no perp pair listed on SoDEX."
                : undefined
            }
            className="font-[var(--font-jetbrains-mono)] transition-all"
            style={{
              fontSize: "10px",
              fontWeight: 600,
              letterSpacing: "0.18em",
              padding: "7px 16px",
              border: `1px solid ${busy === null && !venueBlocksExecute ? POSITIVE : BORDER_QUIET}`,
              color:
                busy === null && !venueBlocksExecute ? POSITIVE : TEXT_DIM,
              background:
                busy === null && !venueBlocksExecute
                  ? "rgba(92, 201, 122, 0.06)"
                  : "transparent",
              cursor:
                venueBlocksExecute
                  ? "not-allowed"
                  : busy === null
                    ? "pointer"
                    : "wait",
              textTransform: "uppercase",
              borderRadius: "2px",
            }}
          >
            Execute on SoDEX →
          </button>
          {venueBlocksExecute ? (
            <span
              className="font-[var(--font-inter)]"
              style={{
                fontSize: "12px",
                color: WARNING,
                fontStyle: "italic",
              }}
            >
              No perp market — shorts can&apos;t be filled on spot.
            </span>
          ) : null}
          <button
            onClick={onDismiss}
            disabled={busy !== null}
            className="font-[var(--font-jetbrains-mono)] transition-all"
            style={{
              fontSize: "10px",
              fontWeight: 500,
              letterSpacing: "0.18em",
              padding: "7px 16px",
              border: "none",
              color: TEXT_DIM,
              background: "transparent",
              cursor: busy === null ? "pointer" : "wait",
              textTransform: "uppercase",
            }}
          >
            Dismiss
          </button>
          {error ? (
            <span
              className="font-[var(--font-inter)]"
              style={{ fontSize: "12px", color: NEGATIVE }}
            >
              {error}
            </span>
          ) : null}
        </div>
      ) : null}

      {/* Inline trade builder — expands in place of action buttons */}
      {isPending && !isInfoOnly && building ? (
        <TradeBuilder
          sodexSymbol={sig.sodex_symbol}
          direction={sig.direction}
          isPerp={sig.sodex_symbol.includes("-USD")}
          sizeInput={sizeInput}
          stopInput={stopInput}
          targetInput={targetInput}
          onSize={setSizeInput}
          onStop={setStopInput}
          onTarget={setTargetInput}
          busy={busy === "executing"}
          error={error}
          onConfirm={onConfirmExecute}
          onCancel={() => {
            setError(null);
            setBuilding(false);
          }}
        />
      ) : null}

      {/* INFO-tier hint */}
      {isPending && isInfoOnly ? (
        <div
          className="mt-4 flex items-center gap-3 font-[var(--font-inter)]"
          style={{ fontSize: "12px", color: TEXT_DIM, fontStyle: "italic" }}
        >
          <span>For your information — below conviction floor for execution.</span>
          <button
            onClick={onDismiss}
            disabled={busy !== null}
            className="ml-auto font-[var(--font-jetbrains-mono)]"
            style={{
              fontSize: "9.5px",
              letterSpacing: "0.18em",
              padding: "6px 12px",
              border: "none",
              color: TEXT_DIM,
              fontStyle: "normal",
              textTransform: "uppercase",
              cursor: busy === null ? "pointer" : "wait",
            }}
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </article>
  );
}

function TradeBuilder({
  sodexSymbol,
  direction,
  isPerp,
  sizeInput,
  stopInput,
  targetInput,
  onSize,
  onStop,
  onTarget,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  sodexSymbol: string;
  direction: "long" | "short";
  isPerp: boolean;
  sizeInput: string;
  stopInput: string;
  targetInput: string;
  onSize: (v: string) => void;
  onStop: (v: string) => void;
  onTarget: (v: string) => void;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const size = Number.parseFloat(sizeInput);
  const stop = Number.parseFloat(stopInput);
  const target = Number.parseFloat(targetInput);
  const valid =
    Number.isFinite(size) &&
    size > 0 &&
    Number.isFinite(stop) &&
    stop > 0 &&
    stop < 100 &&
    Number.isFinite(target) &&
    target > 0;
  const risk = valid ? size * (stop / 100) : null;
  const reward = valid ? size * (target / 100) : null;
  const rr = risk != null && reward != null && risk > 0 ? reward / risk : null;
  const directionColor = direction === "long" ? POSITIVE : NEGATIVE;

  return (
    <div
      className="mt-5"
      style={{
        borderTop: `1px solid ${BORDER_QUIET}`,
        paddingTop: "20px",
      }}
    >
      {/* Header */}
      <div
        className="font-[var(--font-jetbrains-mono)]"
        style={{
          fontSize: "10px",
          letterSpacing: "0.22em",
          color: TEXT_MUTED,
          textTransform: "uppercase",
          marginBottom: "16px",
        }}
      >
        Build trade ·{" "}
        <span style={{ color: directionColor }}>{direction}</span>{" "}
        <span style={{ color: TEXT_BRAND }} title={sodexSymbol}>
          {fmtSodexSymbol(sodexSymbol)}
        </span>{" "}
        <span style={{ color: TEXT_DIM }}>· {isPerp ? "perp" : "spot"}</span>
      </div>

      {/* Inputs */}
      <div
        className="flex flex-wrap items-end"
        style={{ columnGap: "24px", rowGap: "16px" }}
      >
        <TradeInput
          label="Size (USD)"
          value={sizeInput}
          onChange={onSize}
          prefix="$"
          step="10"
          min="0"
          width="120px"
        />
        <TradeInput
          label="Stop loss"
          value={stopInput}
          onChange={onStop}
          suffix="%"
          step="0.1"
          min="0.1"
          max="99"
          width="90px"
          tone="negative"
        />
        <TradeInput
          label="Take profit"
          value={targetInput}
          onChange={onTarget}
          suffix="%"
          step="0.1"
          min="0.1"
          width="90px"
          tone="positive"
        />
      </div>

      {/* Live preview */}
      <div
        className="font-[var(--font-jetbrains-mono)] tabular-nums"
        style={{
          fontSize: "11px",
          letterSpacing: "0.06em",
          color: TEXT_MUTED,
          marginTop: "16px",
          textTransform: "uppercase",
        }}
      >
        {risk != null && reward != null ? (
          <>
            <span style={{ color: TEXT_DIM }}>Risk</span>{" "}
            <span style={{ color: NEGATIVE }}>−${risk.toFixed(2)}</span>
            <span style={{ margin: "0 10px", color: TEXT_DIM }}>·</span>
            <span style={{ color: TEXT_DIM }}>Reward</span>{" "}
            <span style={{ color: POSITIVE }}>+${reward.toFixed(2)}</span>
            <span style={{ margin: "0 10px", color: TEXT_DIM }}>·</span>
            <span style={{ color: TEXT_DIM }}>R:R</span>{" "}
            <span style={{ color: TEXT_BRAND }}>{rr?.toFixed(2)}</span>
          </>
        ) : (
          <span style={{ color: TEXT_DIM }}>Enter valid values…</span>
        )}
      </div>

      {/* Confirm / cancel */}
      <div className="mt-5 flex items-center gap-3">
        <button
          onClick={onConfirm}
          disabled={busy || !valid}
          className="font-[var(--font-jetbrains-mono)] transition-all"
          style={{
            fontSize: "10px",
            fontWeight: 600,
            letterSpacing: "0.18em",
            padding: "8px 18px",
            border: `1px solid ${!busy && valid ? POSITIVE : BORDER_QUIET}`,
            color: !busy && valid ? POSITIVE : TEXT_DIM,
            background:
              !busy && valid ? "rgba(92, 201, 122, 0.1)" : "transparent",
            cursor: busy ? "wait" : valid ? "pointer" : "not-allowed",
            textTransform: "uppercase",
            borderRadius: "2px",
          }}
        >
          {busy ? "Routing…" : "Confirm on SoDEX →"}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="font-[var(--font-jetbrains-mono)] transition-all"
          style={{
            fontSize: "10px",
            fontWeight: 500,
            letterSpacing: "0.18em",
            padding: "8px 14px",
            border: "none",
            color: TEXT_DIM,
            background: "transparent",
            cursor: busy ? "wait" : "pointer",
            textTransform: "uppercase",
          }}
        >
          Cancel
        </button>
        {error ? (
          <span
            className="font-[var(--font-inter)]"
            style={{ fontSize: "12px", color: NEGATIVE }}
          >
            {error}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function TradeInput({
  label,
  value,
  onChange,
  prefix,
  suffix,
  step,
  min,
  max,
  width,
  tone = "neutral",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  prefix?: string;
  suffix?: string;
  step?: string;
  min?: string;
  max?: string;
  width?: string;
  tone?: "positive" | "negative" | "neutral";
}) {
  const color =
    tone === "positive"
      ? POSITIVE
      : tone === "negative"
        ? NEGATIVE
        : TEXT_BRAND;
  return (
    <label className="flex flex-col" style={{ minWidth: width ?? "100px" }}>
      <span
        className="font-[var(--font-jetbrains-mono)]"
        style={{
          fontSize: "9px",
          fontWeight: 500,
          letterSpacing: "0.18em",
          color: TEXT_DIM,
          textTransform: "uppercase",
          marginBottom: "6px",
        }}
      >
        {label}
      </span>
      <div
        className="flex items-baseline"
        style={{
          borderBottom: `1px solid ${BORDER_QUIET}`,
          paddingBottom: "4px",
          gap: "4px",
        }}
      >
        {prefix ? (
          <span
            className="font-[var(--font-fraunces)]"
            style={{ fontSize: "16px", color: TEXT_DIM, lineHeight: 1 }}
          >
            {prefix}
          </span>
        ) : null}
        <input
          type="number"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          step={step}
          min={min}
          max={max}
          className="font-[var(--font-fraunces)] tabular-nums"
          style={{
            background: "transparent",
            border: "none",
            outline: "none",
            color,
            fontSize: "18px",
            fontWeight: 400,
            letterSpacing: "-0.01em",
            lineHeight: 1.1,
            width: "100%",
            padding: 0,
            MozAppearance: "textfield",
          }}
        />
        {suffix ? (
          <span
            className="font-[var(--font-fraunces)]"
            style={{ fontSize: "16px", color: TEXT_DIM, lineHeight: 1 }}
          >
            {suffix}
          </span>
        ) : null}
      </div>
    </label>
  );
}

function TradeFigure({
  value,
  label,
  tone = "neutral",
}: {
  value: string;
  label: string;
  tone?: "positive" | "negative" | "warning" | "neutral";
}) {
  const color =
    tone === "positive"
      ? POSITIVE
      : tone === "negative"
        ? NEGATIVE
        : tone === "warning"
          ? WARNING
          : TEXT_BRAND;
  return (
    <div className="flex flex-col" style={{ minWidth: "62px" }}>
      <span
        className="font-[var(--font-fraunces)] tabular-nums"
        style={{
          fontSize: "17px",
          fontWeight: 400,
          color,
          letterSpacing: "-0.012em",
          lineHeight: 1.1,
        }}
      >
        {value}
      </span>
      <span
        className="font-[var(--font-jetbrains-mono)]"
        style={{
          fontSize: "8.5px",
          fontWeight: 500,
          letterSpacing: "0.16em",
          color: TEXT_DIM,
          marginTop: "4px",
          textTransform: "uppercase",
        }}
      >
        {label}
      </span>
    </div>
  );
}
