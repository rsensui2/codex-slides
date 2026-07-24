"use client";

import Image from "next/image";
import { ArrowUpRight, CaretDown } from "@phosphor-icons/react";
import { useEffect, useState } from "react";

/** Slim app bar with the current workspace shortcut. */
export default function TopBar({ workspace = "Codex Slides" }: { workspace?: string }) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const on = () => setScrolled(window.scrollY > 4);
    on();
    window.addEventListener("scroll", on);
    return () => window.removeEventListener("scroll", on);
  }, []);

  return (
    <header className={`appbar${scrolled ? " scrolled" : ""}`}>
      <div className="brand-lockup">
        <a
          className="product-lockup"
          href="https://github.com/rsensui2/codex-slides"
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`${workspace} on GitHub (opens in a new tab)`}
        >
          <span className="brand-mark-shell" aria-hidden="true">
            <Image
              className="brand-mark"
              src="/brand/codex-slides-mark.png"
              alt=""
              width={32}
              height={32}
              priority
            />
          </span>
          <span className="product-name">
            {workspace}
            <CaretDown className="product-caret" size={11} weight="bold" aria-hidden="true" />
          </span>
        </a>

        <span className="brand-lockup-divider" aria-hidden="true" />

        <a
          className="powered-by-link"
          href="https://github.com/nexu-io/open-design"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Open Design on GitHub (opens in a new tab)"
        >
          <span className="powered-by-label">Powered by</span>
          <span className="powered-by-name">
            Open Design
            <ArrowUpRight size={11} weight="bold" aria-hidden="true" />
          </span>
        </a>
      </div>
    </header>
  );
}
