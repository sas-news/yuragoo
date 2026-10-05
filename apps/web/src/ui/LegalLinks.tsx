// Public legal links (Task 38 + custom-domain release polish): /privacy and
// /terms are static pages served by the same worker, so plain anchors are
// enough — no router. Rendered at the foot of every non-game surface so the
// pages stay reachable from home, join, lobby and error states alike.
import styles from "./ui.module.css";

export function LegalLinks() {
  return (
    <>
      <a className={styles.legalLink} href="/privacy">
        プライバシー
      </a>
      <a className={styles.legalLink} href="/terms">
        利用規約
      </a>
    </>
  );
}

export function LegalFoot({ children }: { children?: React.ReactNode }) {
  return (
    <footer className={styles.legalFoot}>
      {children}
      <LegalLinks />
    </footer>
  );
}
