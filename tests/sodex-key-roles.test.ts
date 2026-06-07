/**
 * Tests for the SoDEX key-role classifier.
 *
 * Pins behavior so a future tweak doesn't accidentally treat `web` or
 * `default` as a Helix-usable key (which would make /signals stop
 * prompting users to create one).
 */
import { describe, it, expect } from "vitest";
import {
  classifyKey,
  hasHelixKey,
  isHelixManagedKey,
  isSystemKey,
  systemKeys,
  userManagedKeys,
} from "@/lib/sodex-onchain/key-roles";
import type { SodexApiKeyRow } from "@/lib/sodex-onchain/types";

function row(name: string): SodexApiKeyRow {
  return {
    name,
    publicKey: "0xdeadbeef",
    keyType: "EVM",
    permissions: 0,
  } as unknown as SodexApiKeyRow;
}

describe("key-roles", () => {
  it("classifies `default` as system", () => {
    expect(classifyKey("default")).toBe("system");
    expect(isSystemKey("default")).toBe(true);
    expect(isHelixManagedKey("default")).toBe(false);
  });

  it("classifies `web` as system (SoDEX auto-creates this)", () => {
    expect(classifyKey("web")).toBe("system");
    expect(isSystemKey("web")).toBe(true);
  });

  it("classifies `helix-…` as helix-managed", () => {
    expect(classifyKey("helix-bot-a3f2")).toBe("helix");
    expect(isHelixManagedKey("helix-bot-a3f2")).toBe(true);
    expect(isSystemKey("helix-bot-a3f2")).toBe(false);
  });

  it("classifies anything else as external", () => {
    expect(classifyKey("my-trading-bot")).toBe("external");
    expect(classifyKey("")).toBe("external");
    expect(classifyKey("hyperliquid-arb")).toBe("external");
  });

  it("userManagedKeys filters out web and default", () => {
    const keys = [
      row("default"),
      row("web"),
      row("helix-abcd"),
      row("third-party-bot"),
    ];
    const ours = userManagedKeys(keys);
    expect(ours.map((k) => k.name)).toEqual([
      "helix-abcd",
      "third-party-bot",
    ]);
  });

  it("systemKeys returns only web and default", () => {
    const keys = [
      row("default"),
      row("web"),
      row("helix-abcd"),
      row("third-party-bot"),
    ];
    expect(systemKeys(keys).map((k) => k.name)).toEqual(["default", "web"]);
  });

  it("hasHelixKey ignores web/default but returns true for helix-*", () => {
    expect(hasHelixKey([row("default"), row("web")])).toBe(false);
    expect(hasHelixKey([row("default"), row("web"), row("helix-x")])).toBe(true);
  });

  it("hasHelixKey returns false for accounts with only third-party externals", () => {
    // The user has no Helix-minted key even though they have third-
    // party externals on the account. The "Create your first Helix
    // API key" CTA should still fire.
    expect(hasHelixKey([row("default"), row("web"), row("hyperliquid-bot")])).toBe(false);
  });
});
