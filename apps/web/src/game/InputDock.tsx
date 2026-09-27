// Party input dock: a single bottom bar that never covers the stage. Three
// safety properties live here: (1) IME composition — Enter only submits when
// no composition is in flight, tracked via BOTH nativeEvent.isComposing and
// a compositionstart/end ref (some browsers report isComposing unreliably
// on the Enter that ends composition); (2) double-submit — an inFlight ref
// plus the parent's pending status collapse rapid clicks into one submit;
// (3) grapheme limits — maxLength is useless (UTF-16 units ≠ graphemes), so
// a live counter + submit-time validation enforce POST_TEXT_MAX_GRAPHEMES.
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { countGraphemes, POST_TEXT_MAX_GRAPHEMES, validatePostText } from "@yuragoo/protocol";
import styles from "./InputDock.module.css";

export interface InputDockProps {
  readonly canPost: boolean;
  readonly status: "idle" | "pending";
  readonly disabledReason?: string | undefined;
  readonly seatLabel?: string | undefined;
  // The acting seat's assigned goal (/play) — shown under the seat line as
  // 「ねらい：◇…」. Omitted on /dev/game, where the column stays as it was.
  readonly goalLabel?: string | undefined;
  // Slot color of the player whose turn it is — tints the send button and
  // the acting-seat spine.
  readonly sendColor?: string | undefined;
  // Optional secondary control rendered inside the tray just before the
  // send button (the room's TURN-mode パスする lives here, so the tray's
  // bottom edge stays flush — nothing sits between dock and screen edge).
  readonly trailing?: ReactNode;
  // Drops the teal rim along the tray's bottom edge — the room screen puts
  // its own draining bar right under the box, so a second border would
  // read as a stray line.
  readonly flushBottom?: boolean | undefined;
  // Server-clock deadline + ticking clock (both undefined while posting is
  // impossible). When now reaches the deadline the CURRENT draft ships
  // as-is — whatever is in the box counts as the answer, grapheme-clamped
  // to the wire cap. Once per deadline value; empty drafts stay silent.
  readonly deadlineAtMs?: number | undefined;
  readonly nowMs?: number | undefined;
  readonly onSubmit: (text: string) => void;
}

// Remaining-grapheme count at which the counter starts warning.
const WARN_REMAINING = 20;

export function InputDock(props: InputDockProps) {
  const {
    canPost,
    status,
    disabledReason,
    seatLabel,
    goalLabel,
    sendColor,
    trailing,
    flushBottom,
    deadlineAtMs,
    nowMs,
    onSubmit,
  } = props;
  const [text, setText] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const composingRef = useRef(false);
  const inFlightRef = useRef(false);
  const prevStatusRef = useRef(status);
  // The deadline the auto-send already consumed; a new deadline (turn
  // rotation / next match) re-arms it because the value itself changes.
  const firedDeadlineRef = useRef<number | null>(null);
  const counterId = useId();
  const errorId = useId();

  const remaining = POST_TEXT_MAX_GRAPHEMES - countGraphemes(text.trim());
  const overLimit = remaining < 0;
  // The over-limit error is live (typing past the cap shows it at once);
  // the empty error only appears after a submit attempt. The live text
  // carries the over-count so the counter's state is announced, not just
  // shown (Task 27).
  const shownError = overLimit ? `文字数オーバー（${-remaining}字おおい）` : submitError;
  const blocked = !canPost || status === "pending";

  // Ack semantics: the parent drives status pending -> idle once the post
  // was processed, and only then is the draft cleared.
  useEffect(() => {
    const wasPending = prevStatusRef.current === "pending";
    prevStatusRef.current = status;
    if (wasPending && status === "idle") {
      setText("");
      setSubmitError(null);
      inFlightRef.current = false;
    }
  }, [status]);

  const trySubmit = useCallback((): void => {
    if (!canPost || status === "pending" || inFlightRef.current) return;
    const result = validatePostText(text);
    if (!result.ok) {
      setSubmitError(result.reason === "empty" ? "なにか書いてね" : "文字数オーバー");
      return;
    }
    inFlightRef.current = true;
    setSubmitError(null);
    onSubmit(result.text);
  }, [canPost, status, text, onSubmit]);

  // Deadline auto-send: the parent only hands us a deadline while posting
  // is possible, so reaching it means "whatever is in the box ships".
  // Length never blocks the send — the draft is grapheme-clamped to the
  // wire cap — but an empty box still stays silent.
  useEffect(() => {
    if (firedDeadlineRef.current !== null && firedDeadlineRef.current !== deadlineAtMs) {
      firedDeadlineRef.current = null; // new deadline re-arms
    }
    if (
      !canPost ||
      status === "pending" ||
      deadlineAtMs === undefined ||
      nowMs === undefined ||
      deadlineAtMs <= 0 ||
      nowMs < deadlineAtMs ||
      firedDeadlineRef.current === deadlineAtMs
    ) {
      return;
    }
    const draft = text.trim();
    if (draft === "") return;
    firedDeadlineRef.current = deadlineAtMs;
    const parts =
      typeof Intl.Segmenter === "function"
        ? Array.from(
            new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(draft),
            (s) => s.segment,
          )
        : Array.from(draft);
    inFlightRef.current = true;
    setSubmitError(null);
    onSubmit(parts.slice(0, POST_TEXT_MAX_GRAPHEMES).join(""));
  }, [canPost, status, deadlineAtMs, nowMs, text, onSubmit]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key !== "Enter" || event.shiftKey) return;
    // While composing (or on the composition-ending Enter, keyCode 229),
    // Enter confirms the IME candidate and must NEVER submit.
    if (composingRef.current || event.nativeEvent.isComposing || event.keyCode === 229) {
      return;
    }
    event.preventDefault();
    trySubmit();
  };

  const onChange = (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const next = event.target.value;
    setText(next);
    if (submitError !== null && validatePostText(next).ok) {
      setSubmitError(null);
    }
  };

  return (
    <form
      className={`${styles.dock}${flushBottom === true ? ` ${styles.dockFlush}` : ""}`}
      aria-label="投稿ドック"
      style={sendColor === undefined ? undefined : ({ "--send-color": sendColor } as CSSProperties)}
      onSubmit={(event) => {
        event.preventDefault();
        trySubmit();
      }}
    >
      <div className={styles.whoBox}>
        {seatLabel !== undefined ? <span className={styles.seat}>{seatLabel}</span> : null}
        {goalLabel !== undefined ? (
          <span className={styles.goal} data-testid="dock-goal" title={`ねらい：${goalLabel}`}>
            ねらい：{goalLabel}
          </span>
        ) : null}
        {!canPost && disabledReason !== undefined ? (
          <span className={styles.hint} data-testid="input-hint">
            {disabledReason}
          </span>
        ) : null}
      </div>
      <div className={styles.field}>
        <div className={styles.inputFrame}>
          <textarea
            className={styles.input}
            data-testid="game-input"
            rows={2}
            placeholder="ひとことで世界をゆさぶる…"
            disabled={!canPost}
            aria-label="投稿テキスト"
            aria-invalid={shownError !== null}
            aria-describedby={`${counterId} ${errorId}`}
            value={text}
            onChange={onChange}
            onKeyDown={onKeyDown}
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
          />
          {/* Both annotations ride the frame as overlays — nothing sits in
              the flow below the input, so input/pass/send share one
              vertical center line. */}
          <span id={errorId} className={styles.error} data-testid="input-error" aria-live="polite">
            {shownError}
          </span>
          <span
            id={counterId}
            className={styles.counter}
            data-testid="input-counter"
            data-warn={remaining <= WARN_REMAINING || undefined}
            data-over={overLimit || undefined}
          >
            残り {remaining}
          </span>
        </div>
      </div>
      {trailing}
      <button type="submit" className={styles.send} data-testid="send-button" disabled={blocked}>
        おくる
      </button>
    </form>
  );
}
