// The in-game scenario banner: one muted line under the HUD, ellipsis-
// truncated when long. A truncated strip is a button — pressing it unfolds
// the full text (要求は「見切れたとき押すと全部見える」). A strip that fits
// stays a plain decorative div so it never pretends to be interactive.
import { type ReactNode, useEffect, useState } from "react";
import arena from "./arena.module.css";

export function ScenarioStrip({ children }: { readonly children: ReactNode }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (el === null) return;
    // While open the text wraps, so scrollWidth==clientWidth — measuring now
    // would flip truncated off and collapse the strip it lives in.
    if (open) return;
    const measure = () => setTruncated(el.scrollWidth > el.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [el, open]);

  if (!truncated) {
    return (
      <div ref={setEl} className={arena.scenarioStrip} data-testid="scenario-strip">
        {children}
      </div>
    );
  }
  return (
    <button
      type="button"
      ref={setEl}
      className={arena.scenarioStrip}
      data-testid="scenario-strip"
      data-open={open || undefined}
      aria-expanded={open}
      title={open ? "たたむ" : "全文を表示"}
      onClick={() => setOpen(!open)}
    >
      {children}
      {!open && (
        <span className={arena.scenarioMore} aria-hidden="true">
          ▾
        </span>
      )}
    </button>
  );
}
