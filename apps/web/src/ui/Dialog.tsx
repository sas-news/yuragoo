// Modal dialog primitive (Task 27): portal-mounted so it escapes every
// stacking/overflow context, then the full modal contract —
// role="dialog" + aria-modal, focus trapped inside, Esc closes, focus
// returns to the element that opened it (or an explicit target), and the
// page behind it is inert for pointer AND assistive tech.
// Open it by rendering it conditionally; close via onClose (Esc, overlay
// click or a button inside). Initial focus goes to [data-autofocus],
// then the first focusable element, then the panel itself.
import { type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import styles from "./ui.module.css";

export interface DialogProps {
  readonly label: string; // aria-label fallback when no labelled element exists
  readonly labelledBy?: string | undefined;
  readonly onClose: () => void;
  // Where focus goes after close — default is the element that was focused
  // when the dialog opened (the trigger). Supply for auto-opened dialogs
  // whose natural landing spot appears only after close (e.g. a reopen chip).
  readonly returnFocus?: (() => HTMLElement | null) | undefined;
  readonly veil?: "dark" | "paper" | undefined;
  readonly panelClassName?: string | undefined;
  readonly testId?: string | undefined;
  readonly children: ReactNode;
}

const FOCUSABLE =
  "a[href], button:not([disabled]), textarea:not([disabled]), " +
  "input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])";

const focusables = (root: HTMLElement): HTMLElement[] =>
  [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.getClientRects().length > 0);

export function Dialog({
  label,
  labelledBy,
  onClose,
  returnFocus,
  veil = "dark",
  panelClassName,
  testId,
  children,
}: DialogProps) {
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Stable ref so the unmount cleanup always calls the latest onClose-side
  // focus logic without re-running the mount effect.
  const returnFocusRef = useRef(returnFocus);
  returnFocusRef.current = returnFocus;

  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    const previous = document.activeElement as HTMLElement | null;
    // Inert everything except the branch containing the dialog: the
    // portal sits on <body>, so every other body child is background.
    const inerted: HTMLElement[] = [];
    for (const child of Array.from(document.body.children)) {
      if (child instanceof HTMLElement && !child.contains(panel)) {
        child.inert = true;
        inerted.push(child);
      }
    }
    const auto = panel.querySelector<HTMLElement>("[data-autofocus]");
    const target = auto ?? focusables(panel)[0] ?? panel;
    target.focus();
    return () => {
      for (const el of inerted) el.inert = false;
      const back = returnFocusRef.current?.() ?? previous;
      back?.focus();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const panel = panelRef.current;
    if (panel === null) return;
    const items = focusables(panel);
    if (items.length === 0) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) return;
    const active = document.activeElement as HTMLElement | null;
    if (event.shiftKey && (active === first || active === panel || !panel.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  // Keys are handled on the dialog panel; the overlay mousedown is the
  // click-outside dismiss affordance.
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: modal backdrop dismiss affordance
    <div
      ref={overlayRef}
      className={`${styles.overlay} ${veil === "paper" ? styles.overlayPaper : styles.overlayDark}`}
      data-testid={testId === undefined ? undefined : `${testId}-overlay`}
      onMouseDown={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy === undefined ? label : undefined}
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={`${styles.panel}${panelClassName === undefined ? "" : ` ${panelClassName}`}`}
        data-testid={testId}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
