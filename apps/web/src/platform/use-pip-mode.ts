// PIP compact mode (Task 48): flips `data-pip` on <html> from either of
// two signals — Discord's ACTIVITY_LAYOUT_MODE_UPDATE event, or the same
// pixel tier seats.ts uses (max-width 460 / max-height 480) so browser
// windows and the e2e bundle exercise the same layout. CSS under
// `html[data-pip]` then collapses each screen to its reduced-info
// variant — the pop-out is for glancing, not full editing.
import { useEffect, useState } from "react";
import { watchLayout } from "@yuragoo/platform";
import { discordClientId, getDiscordSdk, platformKind } from "./bootstrap";

// Keep in sync with seats.ts TINY_W/TINY_H and the PlayerSeats media tier.
const PIP_QUERY = "(max-width: 460px), (max-height: 480px)";

export const usePipMode = (): boolean => {
  const [pip, setPip] = useState(false);
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
          watcher = watchLayout(sdk, (state) => {
            discordPip = state.mode === "pip";
            apply();
          });
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
