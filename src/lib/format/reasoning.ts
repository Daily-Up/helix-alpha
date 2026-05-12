/**
 * Strip the technical scoring breakdown ("Conviction X% = cls ... × Xw + ...")
 * and the significance debug line ("Significance X.XXX → INFO; score=...;
 * magnitude=...; instance=...; novelty=X (X similar in window)") from a
 * signal's reasoning text.
 *
 * These blocks live in the persisted `reasoning` column for audit
 * purposes — they explain why the conviction came out the way it did.
 * The full breakdown is useful for engineers but noisy for the UI: the
 * dashboard surfaces conviction as a single percentage and the per-axis
 * weights are not actionable for a human reader.
 */
export function stripTechnicalScoring(text: string): string {
  let cleaned = text;
  // Conviction breakdown: starts at "Conviction NN% = cls" and ends at
  // the period after "novelty NN% × Nw." (last term in the formula).
  cleaned = cleaned.replace(
    /\s*Conviction \d+% = cls [\s\S]*?novelty \d+% × \d+w\.?/g,
    "",
  );
  // Significance debug line: starts at "Significance N.NNN →" and ends
  // at the closing ")" of "(N similar in window)".
  cleaned = cleaned.replace(
    /\s*Significance \d+\.\d+ →[\s\S]*?\(\d+ similar in window\)\.?/g,
    "",
  );
  return cleaned.replace(/\n{3,}/g, "\n\n").trim();
}
