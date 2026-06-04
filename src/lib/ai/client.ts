/**
 * Anthropic SDK singleton.
 *
 * One shared client per process — keeps the TLS connection pooled and
 * lets us inspect token usage in one place.
 */

import Anthropic from "@anthropic-ai/sdk";
import { env } from "@/lib/env";

let _client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }
  return _client;
}

/** Currently configured model. Used by reasoning-heavy paths
 *  (research agent, verification, debate, daily briefing) where the
 *  quality gap between Sonnet and Haiku matters. */
export function getModel(): string {
  return env.ANTHROPIC_MODEL;
}

/**
 * Model for the batch classifier — the cheap, high-volume tag-and-
 * route work that runs on every ingested news event. Haiku is roughly
 * 5× cheaper than Sonnet and the task (structured output: event_type,
 * sentiment, severity, affected_assets) doesn't need Sonnet's
 * reasoning depth. Default: claude-haiku-4-5.
 *
 * Override via ANTHROPIC_CLASSIFIER_MODEL env var (e.g. flip back to
 * claude-sonnet-4-5 if Haiku misclassifies and the downstream signal
 * quality drops noticeably).
 */
export function getClassifierModel(): string {
  return env.ANTHROPIC_CLASSIFIER_MODEL;
}
