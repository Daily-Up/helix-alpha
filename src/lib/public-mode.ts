/**
 * Public-mode gate — separates "what you see locally while building" from
 * "what a public viewer (buildathon judge) sees on the deployed site".
 *
 * Enabled when `NEXT_PUBLIC_PUBLIC_MODE` is set to "1". The flag is set
 * on the Vercel production deployment and left unset locally, so dev
 * always sees every page in its real, working state.
 *
 * Use this for features that are real and shippable in code but whose
 * data/calibration is still maturing. The UI surfaces a "coming soon"
 * or "warming up" frame for public viewers; locally everything renders
 * as usual so we can keep iterating.
 *
 * Anything wrapped in this gate is wave-2 / wave-3 scope on the public
 * roadmap.
 */
export function isPublicMode(): boolean {
  return process.env.NEXT_PUBLIC_PUBLIC_MODE === "1";
}
