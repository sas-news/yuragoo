// Public anonymous stats dialog (Task 38). The 「とうけい」 link opens a
// small panel fed by GET <apiOrigin>/api/stats — the deployment-wide
// numbers-only totals (completed games / posts / durations, UTC-day
// buckets before today). Under 20 completed games the API answers
// "pending" and we say so politely; nothing per-room or per-player is
// ever displayed because the payload cannot carry it.
import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { apiOrigin } from "../lobby/room-session";
import { Dialog } from "../ui/Dialog";
import styles from "./Stats.module.css";

type PublicStats =
  | { readonly status: "pending" }
  | {
      readonly status: "ok";
      readonly completedGames: number;
      readonly totalMessages: number;
      readonly totalDurationMs: number;
      readonly averageDurationMs: number;
    };

type Load =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly stats: PublicStats }
  | { readonly kind: "error" };

const isStats = (v: unknown): v is PublicStats =>
  v !== null &&
  typeof v === "object" &&
  ((v as { status?: unknown }).status === "pending" ||
    ((v as { status?: unknown }).status === "ok" &&
      typeof (v as { completedGames?: unknown }).completedGames === "number" &&
      typeof (v as { totalMessages?: unknown }).totalMessages === "number" &&
      typeof (v as { averageDurationMs?: unknown }).averageDurationMs === "number"));

// "だいたい N ふん" — the published totals are already rounded; a soft
// minute figure is all a visitor needs.
const minutesOf = (ms: number): number => Math.max(1, Math.round(ms / 60_000));

export function StatsLink() {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<Load>({ kind: "loading" });

  useEffect(() => {
    if (!open) return;
    setLoad({ kind: "loading" });
    let live = true;
    void fetch(`${apiOrigin()}/api/stats`)
      .then(async (res) => {
        const body: unknown = await res.json();
        if (live) setLoad({ kind: "ready", stats: isStats(body) ? body : { status: "pending" } });
      })
      .catch(() => {
        if (live) setLoad({ kind: "error" });
      });
    return () => {
      live = false;
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        className={styles.link}
        onClick={() => setOpen(true)}
        data-testid="stats-link"
      >
        {t("とうけい")}
      </button>
      {open && (
        <Dialog
          label={t("ゆらぐー！の とうけい")}
          veil="paper"
          onClose={() => setOpen(false)}
          testId="stats"
        >
          <h2 className={styles.title} data-autofocus tabIndex={-1}>
            {t("ゆらぐー！の とうけい")}
          </h2>
          {load.kind === "loading" && <p className={styles.note}>{t("よんでいます…")}</p>}
          {load.kind === "error" && (
            <p className={styles.note} role="alert">
              {t("いまは よめませんでした。")}
            </p>
          )}
          {load.kind === "ready" && load.stats.status === "pending" && (
            <p className={styles.note}>
              {t("まだ あつまっていません。")}
              <br />
              {t("20ゲーム あつまると ひらきます。")}
            </p>
          )}
          {load.kind === "ready" && load.stats.status === "ok" && (
            <>
              <dl className={styles.rows}>
                <div className={styles.row}>
                  <dt>{t("おわったゲーム")}</dt>
                  <dd>{load.stats.completedGames}</dd>
                </div>
                <div className={styles.row}>
                  <dt>{t("みんなの ひとこと")}</dt>
                  <dd>{load.stats.totalMessages}</dd>
                </div>
                <div className={styles.row}>
                  <dt>{t("1ゲームの ながさ")}</dt>
                  <dd>{t("だいたい {n} ふん", { n: minutesOf(load.stats.averageDurationMs) })}</dd>
                </div>
              </dl>
              <p className={styles.hint}>{t("あさまでに あつまった ぶんです。")}</p>
            </>
          )}
        </Dialog>
      )}
    </>
  );
}
