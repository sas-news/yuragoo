// Home (`/`): the product entry — creature + title stay, plus the real
// room-create flow. 「部屋を作る」 posts /api/rooms and navigates straight
// into the new room's lobby with the invite secret riding the URL
// fragment (RoomPage reads and erases it before joining).
import { useState } from "react";
import { gameRulesVersion } from "@yuragoo/game-core";
import { CreatureStage } from "./game/CreatureStage";
import { useT } from "./i18n";
import { StatsLink } from "./info/Stats";
import { apiOrigin, createRoom } from "./lobby/room-session";
import { Button } from "./ui/Button";
import { LegalFoot } from "./ui/LegalLinks";
import styles from "./App.module.css";

export function App() {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onCreate = (): void => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void createRoom(apiOrigin())
      .then(({ roomId, inviteSecret }) => {
        // The fragment is the only place a raw invite secret may ride —
        // the environment params (?api/?hb) carry along so the room page
        // talks to the same worker.
        window.location.assign(`/r/${roomId}${window.location.search}#${inviteSecret}`);
      })
      .catch((e: Error) => {
        setBusy(false);
        setError(t("へやをつくれませんでした（{detail}）", { detail: e.message }));
      });
  };

  return (
    <main className="app-shell">
      <header className="status-strip">
        <h1>ゆらぐー！</h1>
        <span>rules v{gameRulesVersion}</span>
      </header>
      <div className="stage-area">
        <CreatureStage visualState="normal" />
      </div>
      <section className={styles.entry} aria-label={t("はじめる")}>
        <p className={styles.lead}>
          {t("なまえのない生命体を、みんなのひとことで引っ張るパーティーゲーム。")}
        </p>
        <Button variant="big" onClick={onCreate} disabled={busy} data-testid="create-room">
          {busy ? t("つくっています…") : t("部屋を作る")}
        </Button>
        {error !== null && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
      </section>
      <LegalFoot>
        <StatsLink />
      </LegalFoot>
    </main>
  );
}
