// Pre-join panel (Task 24, split from RoomPage for the size cap): the
// invite link already proves entry rights — this only asks what to call
// the member (empty = server-side placeholder name).
import { useState } from "react";
import { Button } from "../ui/Button";
import { TextField } from "../ui/TextField";
import { loadSavedName } from "./room-session";
import styles from "./Lobby.module.css";

export function NamePanel({ onJoin }: { onJoin: (name: string) => void }) {
  // Prefill the last name this browser joined with — the field is editable
  // (変更できる) and an empty submit still falls back to the placeholder.
  const [name, setName] = useState(loadSavedName);
  return (
    <section className={`${styles.plate} ${styles.namePanel}`}>
      <h1 className={styles.title}>ゆらぐー！へや</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onJoin(name);
        }}
      >
        <TextField
          label="おなまえ（あとで変更できません）"
          value={name}
          maxLength={24}
          placeholder="プレイヤー"
          onChange={setName}
        />
        <Button variant="primary" type="submit">
          へやにはいる
        </Button>
      </form>
    </section>
  );
}
