/**
 * Centralized environment variable loader with Zod validation.
 *
 * Importing this module fails loudly at boot if anything required is missing,
 * instead of silently returning `undefined` somewhere deep in an API route.
 *
 * Usage:
 *   import { env } from "@/lib/env";
 *   fetch(env.SOSOVALUE_BASE_URL + "/currencies", {
 *     headers: { "x-soso-api-key": env.SOSOVALUE_API_KEY },
 *   });
 */

import { z } from "zod";

const EnvSchema = z.object({
  // SoSoValue
  SOSOVALUE_API_KEY: z.string().min(1, "SOSOVALUE_API_KEY is required"),
  SOSOVALUE_BASE_URL: z.string().url().default("https://openapi.sosovalue.com/openapi/v1"),

  // SoDEX (mainnet) — public market endpoints don't need a key.
  SODEX_API_KEY: z.string().optional(),
  SODEX_API_SECRET: z.string().optional(),
  SODEX_SPOT_REST_URL: z
    .string()
    .url()
    .default("https://mainnet-gw.sodex.dev/api/v1/spot"),
  SODEX_PERPS_REST_URL: z
    .string()
    .url()
    .default("https://mainnet-gw.sodex.dev/api/v1/perps"),
  SODEX_SPOT_WS_URL: z
    .string()
    .default("wss://mainnet-gw.sodex.dev/ws/spot"),
  SODEX_PERPS_WS_URL: z
    .string()
    .default("wss://mainnet-gw.sodex.dev/ws/perps"),

  // DefiLlama — keyless emissions/unlocks datasets + coins price API.
  // Defaulted so no new secret is required; overridable if the CDN moves.
  DEFILLAMA_DATASETS_URL: z
    .string()
    .url()
    .default("https://defillama-datasets.llama.fi"),
  DEFILLAMA_COINS_URL: z.string().url().default("https://coins.llama.fi"),

  // Anthropic
  ANTHROPIC_API_KEY: z.string().min(1, "ANTHROPIC_API_KEY is required"),
  /** Reasoning-heavy model (agents, briefing). Default: Sonnet 4.5. */
  ANTHROPIC_MODEL: z.string().default("claude-sonnet-4-5"),
  /** Cheap classifier model for batch news tagging. ~5× cheaper than
   *  Sonnet on this task with negligible quality loss. */
  ANTHROPIC_CLASSIFIER_MODEL: z.string().default("claude-haiku-4-5"),

  // Database — Wave 2 onwards: Turso (hosted libSQL). Both URL and token
  // are required at runtime; left optional in the schema so `next build`
  // (which doesn't have prod env) still passes. The client throws if URL
  // is missing when actually queried.
  TURSO_DATABASE_URL: z.string().optional(),
  TURSO_AUTH_TOKEN: z.string().optional(),
  // Legacy — only used by one-off migration scripts that read the local
  // SQLite snapshot. Production code no longer touches this.
  DATABASE_PATH: z.string().default("./data/sosoalpha.db"),

  // Cron auth — required in prod, optional in dev (allows unauthenticated curl)
  CRON_SECRET: z.string().optional(),

  // Public
  NEXT_PUBLIC_APP_NAME: z.string().default("SosoAlpha"),
  NEXT_PUBLIC_APP_TAGLINE: z
    .string()
    .default("Event-Driven Alpha for On-Chain Finance"),
});

export type Env = z.infer<typeof EnvSchema>;

function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(
      `\nInvalid environment configuration:\n${issues}\n\n` +
        `Copy .env.local.example to .env.local and fill in the missing keys.\n`,
    );
  }

  return parsed.data;
}

// Lazy singleton — only validates on first access (so `next build` doesn't
// fail when CI doesn't have keys, only runtime does).
let cached: Env | null = null;

export function getEnv(): Env {
  if (!cached) cached = loadEnv();
  return cached;
}

// Convenience export for code that runs at request time (always has env).
export const env = new Proxy({} as Env, {
  get(_target, prop: keyof Env) {
    return getEnv()[prop];
  },
});
