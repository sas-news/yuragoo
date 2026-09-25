// Shared button primitive (Task 27). type defaults to "button" (the
// inside-a-form footgun), every variant keeps the global 44px / focus-ring
// rules from styles.css, and the class merge means call sites can still
// add layout classes. Variants: plain (bordered plate — the global look),
// primary (teal fill + ink ring), danger (ink-danger outline), big (the
// chamfered teal action used by はじめる / もう一回).
import type { ButtonHTMLAttributes, Ref } from "react";
import styles from "./ui.module.css";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: "plain" | "primary" | "danger" | "big";
  // React 19 ref-as-prop — needed when a parent must restore focus.
  readonly ref?: Ref<HTMLButtonElement>;
}

const VARIANT: Record<NonNullable<ButtonProps["variant"]>, string | undefined> = {
  plain: undefined,
  primary: styles.primary,
  danger: styles.danger,
  big: styles.big,
};

export function Button({ variant = "plain", type, className, ...rest }: ButtonProps) {
  const variantClass = VARIANT[variant];
  const merged = [variantClass, className].filter((c) => c !== undefined && c !== "").join(" ");
  return (
    <button
      type={type === undefined ? "button" : type}
      className={merged === "" ? undefined : merged}
      {...rest}
    />
  );
}
