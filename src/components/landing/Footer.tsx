import Link from "next/link";

const TEXT_TERTIARY = "#6b6760";

export function Footer() {
  return (
    <footer
      className="border-t"
      style={{
        borderColor: "#ede4d310",
        padding: "16px 0",
      }}
    >
      <div className="mx-auto flex max-w-[1280px] items-center justify-between px-6 md:px-12">
        <div
          className="font-[var(--font-jetbrains-mono)]"
          style={{ fontSize: "11px", color: TEXT_TERTIARY, letterSpacing: "0.04em" }}
        >
          <span className="font-[var(--font-fraunces)] font-medium" style={{ fontSize: "13px" }}>
            Helix
          </span>
          {" · "}2025{" · "}paper-traded{" · "}for SoSoValue × AKINDO buildathon
        </div>
        <nav className="hidden items-center gap-5 md:flex">
          <Link
            href="/app"
            className="font-[var(--font-jetbrains-mono)] transition-colors duration-200 hover:text-[#ede4d3]"
            style={{ fontSize: "11px", color: TEXT_TERTIARY, letterSpacing: "0.04em" }}
          >
            Dashboard
          </Link>
          <a
            href="#main"
            className="font-[var(--font-jetbrains-mono)] transition-colors duration-200 hover:text-[#ede4d3]"
            style={{ fontSize: "11px", color: TEXT_TERTIARY, letterSpacing: "0.04em" }}
          >
            Back to top
          </a>
        </nav>
      </div>
    </footer>
  );
}
