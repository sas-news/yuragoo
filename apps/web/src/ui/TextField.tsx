// Labelled text field primitive (Task 27): a real <label> bound to the
// input, an optional hint and an error line. The input is wired for screen
// readers by construction — aria-invalid while an error shows, and
// aria-describedby always points at the live hint/error so the message is
// read in context and announced when it appears.
import { type ChangeEvent, type InputHTMLAttributes, useId } from "react";
import styles from "./ui.module.css";

export interface TextFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly maxLength?: number | undefined;
  readonly placeholder?: string | undefined;
  readonly hint?: string | undefined;
  readonly error?: string | null | undefined;
  readonly className?: string | undefined;
  readonly inputProps?: InputHTMLAttributes<HTMLInputElement> | undefined;
}

export function TextField({
  label,
  value,
  onChange,
  maxLength,
  placeholder,
  hint,
  error,
  className,
  inputProps,
}: TextFieldProps) {
  const inputId = useId();
  const noteId = useId();
  const note = error ?? hint ?? null;
  return (
    <div className={`${styles.field}${className === undefined ? "" : ` ${className}`}`}>
      <label className={styles.fieldLabel} htmlFor={inputId}>
        {label}
      </label>
      <input
        id={inputId}
        className={styles.input}
        value={value}
        maxLength={maxLength}
        placeholder={placeholder}
        aria-invalid={error !== null && error !== undefined && error !== ""}
        aria-describedby={note === null ? undefined : noteId}
        onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        {...inputProps}
      />
      {note !== null && (
        <p
          id={noteId}
          className={error ? styles.fieldError : styles.fieldHint}
          aria-live={error ? "polite" : undefined}
        >
          {note}
        </p>
      )}
    </div>
  );
}
