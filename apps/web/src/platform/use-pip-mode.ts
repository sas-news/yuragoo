// PIP compact mode (Task 48): flips `data-pip` on <html> from either of
// two signals — Discord's ACTIVITY_LAYOUT_MODE_UPDATE event, or the same
// pixel tier seats.ts uses (max-width 460 / max-height 480) so browser
// windows and the e2e bundle exercise the same layout. CSS under
// `html[data-pip]` then collapses each screen to its reduced-info
// variant — the pop-out is for glancing, not full editing.
import { useEffect, useRef, useState } from "react";
import { watchLayout } from "@yuragoo/platform";
import { discordClientId, getDiscordSdk, platformKind } from "./bootstrap";

// Keep in sync with seats.ts TINY_W/TINY_H and the PlayerSeats media tier.
const PIP_QUERY = "(max-width: 460px), (max-height: 480px)";

export const usePipMode = (
  // Discord rooms pass a reporter so participant events double as the
  // activity-leave detector (the server drops anyone missing whose
  // discord_user_id is verified — Task 48). One-shot boot fetch covers
  // departures that happened before the subscription landed.
  onParticipants?: (userIds: readonly string[]) => void,
): boolean => {
  const [pip, setPip] = useState(false);
  // Always call the latest reporter — the effect mounts once, the conn ref
  // inside it resolves lazily per event.
  const reportRef = useRef(onParticipants);
  reportRef.current = onParticipants;
  useEffect(() => {
    const root = document.documentElement;
    let discordPip = false;
    let mediaPip = false;
    const apply = (): void => {
      const next = discordPip || mediaPip;
      setPip(next);
      if (next) root.dataset.pip = "true";
      else delete root.dataset.pip;
    };

    const mq = window.matchMedia(PIP_QUERY);
    const onMedia = (): void => {
      mediaPip = mq.matches;
      apply();
    };
    onMedia();
    mq.addEventListener("change", onMedia);

    let watcher: { stop(): void } | null = null;
    if (platformKind() === "discord") {
      void getDiscordSdk(discordClientId())
        .then((sdk) => {
          watcher = watchLayout(
            sdk,
            (state) => {
              discordPip = state.mode === "pip";
              apply();
            },
            (ids) => reportRef.current?.(ids),
          );
          void sdk.commands
            .getActivityInstanceConnectedParticipants?.()
            .then((res) => {
              const ids = (res?.participants ?? [])
                .map((p) => p.id)
                .filter((id): id is string => typeof id === "string" && id !== "");
              reportRef.current?.(ids);
            })
            .catch(() => {});
        })
        .catch(() => {});
    }

    return () => {
      mq.removeEventListener("change", onMedia);
      watcher?.stop();
      delete root.dataset.pip;
    };
  }, []);
  return pip;
};
