// Live status region (Task 27): role="status" (implicit aria-live polite)
// + atomic, so every update announces the whole text. Rendered always —
// even when empty — so the region exists before the first update lands.
// The caller chooses visibility: the global .sr-only class hides it for
// screen-reader-only channels; a module class renders it as a visible
// subtle line (the creature stage uses that for its DOM alternative).
export interface StatusProps {
  readonly text: string;
  readonly className?: string | undefined;
  readonly testId?: string | undefined;
}

export function Status({ text, className, testId }: StatusProps) {
  return (
    <span role="status" aria-atomic="true" className={className} data-testid={testId}>
      {text}
    </span>
  );
}
