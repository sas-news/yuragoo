// Public legal links (Task 38 + custom-domain release polish): /privacy and
// /terms are static pages served by the same worker, so plain anchors are
// enough — no router. Rendered at the foot of every non-game surface so the
// pages stay reachable from home, join, lobby and error states alike.
import { useT } from "../i18n";
import styles from "./ui.module.css";

export function LegalLinks() {
  const t = useT();
  return (
    <>
      <a className={styles.legalLink} href="/privacy">
        {t("プライバシー")}
      </a>
      <a className={styles.legalLink} href="/terms">
        {t("利用規約")}
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
