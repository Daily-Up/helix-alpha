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

/** Currently configured model. */
export function getModel(): string {
  return env.ANTHROPIC_MODEL;
}
