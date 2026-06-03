/**
 * Unit tests for the X hack-tweet filter.
 *
 * The two failure modes that matter:
 *   - false negatives: a real Halborn/PeckShield exploit alert getting
 *     dropped → we miss the trade entirely
 *   - false positives: BNB Hack hackathon / AI safety commentary getting
 *     surfaced → noise in the audit feed
 *
 * Both are exercised here with realistic fixtures from live SoSoValue.
 */
import { describe, expect, it } from "vitest";
import { _internals } from "@/lib/ingest/x-hack-feed";

const {
  isSecurityAuthor,
  passesFalsePositiveFilter,
  synthesiseTitle,
} = _internals;

describe("isSecurityAuthor", () => {
  it("matches HalbornSecurity (case-insensitive substring)", () => {
    expect(isSecurityAuthor("HalbornSecurity")).toBe(true);
  });
  it("matches PeckShieldAlert", () => {
    expect(isSecurityAuthor("PeckShieldAlert")).toBe(true);
  });
  it("matches zachxbt", () => {
    expect(isSecurityAuthor("zachxbt")).toBe(true);
  });
  it("matches SlowMist_Team", () => {
    expect(isSecurityAuthor("SlowMist_Team")).toBe(true);
  });
  it("matches CertiKAlert", () => {
    expect(isSecurityAuthor("CertiKAlert")).toBe(true);
  });
  it("rejects unknown handle", () => {
    expect(isSecurityAuthor("DefiantNews")).toBe(false);
    expect(isSecurityAuthor("Cointelegraph")).toBe(false);
  });
  it("handles null/empty gracefully", () => {
    expect(isSecurityAuthor(null)).toBe(false);
    expect(isSecurityAuthor("")).toBe(false);
    expect(isSecurityAuthor(undefined)).toBe(false);
  });
});

describe("passesFalsePositiveFilter — REJECTS hackathon/contest noise", () => {
  const reject = (title: string, content: string) =>
    passesFalsePositiveFilter({
      title,
      content,
    } as unknown as Parameters<typeof passesFalsePositiveFilter>[0]);

  it("rejects 'BNB HACK: AI Trading Agent Edition' (real false positive)", () => {
    expect(
      reject(
        "",
        "🚨 BNB HACK: AI Trading Agent Edition is LIVE! Win API and Compute Credits + Mentorship | $36K Prize Pool",
      ),
    ).toBe(false);
  });

  it("rejects 'BNB Hack: AI Trading Agent Season'", () => {
    expect(
      reject(
        "",
        "BNB Chain announced launching BNB Hack: AI Trading Agent Season with prize pool",
      ),
    ).toBe(false);
  });

  it("rejects hackathon announcements", () => {
    expect(
      reject(
        "ETH Hack Lisbon registration opens",
        "Join the hackathon, submission deadline July 30",
      ),
    ).toBe(false);
  });

  it("rejects 'winners of the hack' post-event coverage", () => {
    expect(reject("", "Announcing the winners of the hack competition")).toBe(false);
  });
});

describe("passesFalsePositiveFilter — ACCEPTS real exploit alerts", () => {
  const ok = (title: string, content: string) =>
    passesFalsePositiveFilter({
      title,
      content,
    } as unknown as Parameters<typeof passesFalsePositiveFilter>[0]);

  it("accepts HalbornSecurity SquidRouter post (real exploit)", () => {
    expect(
      ok(
        "",
        "The SquidRouterModule hack was enabled by a fixed verification string in a public contract. Attacker read the BaseScan-verified bytecode and reconstructed the signature.",
      ),
    ).toBe(true);
  });

  it("accepts 'Gnosis Pay exploit drained $1.2M' style content", () => {
    expect(
      ok(
        "",
        "Hackers drained ~$1.2M from Gnosis Pay users' card-linked wallets via a flash loan attack on the Zodiac delay module.",
      ),
    ).toBe(true);
  });

  it("accepts Radiant Capital shutdown post (real exploit, $51M)", () => {
    expect(
      ok(
        "DeFi protocol Radiant to wind down after failing to recover from 2024 hack",
        "Radiant Capital is unable to recover from the October 2024 hack that drained approximately $51M.",
      ),
    ).toBe(true);
  });
});

describe("synthesiseTitle", () => {
  it("uses first sentence when content has period", () => {
    const t = synthesiseTitle(
      "HalbornSecurity",
      "The SquidRouterModule hack was enabled by a fixed verification string. More details in thread.",
    );
    expect(t).toContain("@HalbornSecurity");
    expect(t).toContain("SquidRouterModule");
    expect(t.length).toBeLessThan(260);
  });

  it("clamps to 240 chars when no early period", () => {
    const huge = "A".repeat(500);
    const t = synthesiseTitle("zachxbt", huge);
    // Length budget: handle prefix + space + 240 content + ellipsis
    expect(t.length).toBeLessThan(260);
    expect(t.startsWith("[@zachxbt]")).toBe(true);
  });

  it("returns empty string for empty content", () => {
    expect(synthesiseTitle("zachxbt", "")).toBe("");
    expect(synthesiseTitle(null, "")).toBe("");
  });

  it("falls back to [X] when author is null", () => {
    const t = synthesiseTitle(null, "Flash loan attack drained $5M from XYZ protocol.");
    expect(t.startsWith("[X]")).toBe(true);
  });
});
