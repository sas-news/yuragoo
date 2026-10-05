// Attractor-anchored player table: each player's chip is planted on their
// attractor post — the marker the creature pulls toward. Positions arrive
// pre-computed in arena px (see seats.ts); chips are centered on the anchor
// via translate(-50%,-50%). The current player's chip pulses a slot-colored
// ring — the glow IS the turn indicator (the HUD turn line stays for a11y).
import type { CSSProperties } from "react";
import type { Player, PlayerId } from "@yuragoo/game-core";
import { useT } from "../i18n";
import { IconFace } from "./IconFace";
import styles from "./PlayerSeats.module.css";
import type { SeatMap } from "./seats";
import { slotBadge, slotColor } from "./slots";

// A seat's assigned goal (one per roster slot) — rendered as a small muted
// line under the player name on /play; omitted on /dev/game.
export interface SeatGoal {
  readonly symbol: string;
  readonly label: string;
}

export interface PlayerSeatsProps {
  readonly roster: readonly Player[];
  readonly positions: SeatMap;
  readonly currentId?: PlayerId | undefined;
  readonly nameOf?: ((id: PlayerId) => string) | undefined;
  readonly goals?: readonly SeatGoal[] | undefined; // indexed by slot
  // When provided (LIVE mode on /play), each chip gains a transparent hit
  // button so a tap picks the acting seat; omitted = purely decorative.
  readonly onSelect?: ((id: PlayerId) => void) | undefined;
  // The seat the last verdict pulled toward — a brief outward pulse so
  // "which way did it go" reads on the seat itself, not only in the feed.
  readonly pulledId?: PlayerId | undefined;
  // Optional avatar lookup (room members carry their platform avatar —
  // Discord CDN URL — on the wire view). Falls back to the IconFace.
  readonly avatarOf?: ((id: PlayerId) => string | undefined) | undefined;
}

export function PlayerSeats(props: PlayerSeatsProps) {
  const t = useT();
  const {
    roster,
    positions,
    currentId,
    nameOf = (id) => id,
    goals,
    onSelect,
    pulledId,
    avatarOf,
  } = props;

  return (
    <ul className={styles.seats} aria-label={t("プレイヤーの席")}>
      {roster.map((player) => {
        const pos = positions[player.id];
        // No anchor yet (creature still warming up) -> no chip.
        if (pos === undefined) return null;
        const isCurrent = player.id === currentId;
        const goal = goals?.[player.slot];
        const style = {
          left: `${pos.x}px`,
          top: `${pos.y}px`,
          "--seat-color": slotColor(player.slot),
        } as CSSProperties;
        return (
          <li
            key={player.id}
            className={styles.seat}
            style={style}
            data-testid={`seat-${player.id}`}
            data-slot={player.slot}
            data-anchor-x={pos.x}
            data-anchor-y={pos.y}
            data-current={isCurrent || undefined}
            data-pulled={player.id === pulledId || undefined}
            data-selectable={onSelect !== undefined || undefined}
            aria-label={t("{name} の席", { name: nameOf(player.id) })}
            aria-current={isCurrent || undefined}
          >
            {/* The turn pointer: a slot-colored wedge over the acting
                seat — visible even when the pulse is reduced away. */}
            <span className={styles.turnMark} data-on={isCurrent || undefined} aria-hidden="true">
              ▼
            </span>
            <span
              className={styles.avatar}
              style={{ "--slot-bg": slotColor(player.slot) } as CSSProperties}
              aria-hidden="true"
            >
              {avatarOf?.(player.id) === undefined ? (
                <IconFace />
              ) : (
                <img
                  className={styles.avatarImg}
                  src={avatarOf?.(player.id)}
                  alt=""
                  width={64}
                  height={64}
                />
              )}
            </span>
            <span className={styles.who}>
              <span className={styles.name}>
                <span className={styles.tag} aria-hidden="true">
                  {slotBadge(player.slot)}
                </span>
                {nameOf(player.id)}
              </span>
              {goal === undefined ? null : (
                <span
                  className={styles.goal}
                  data-testid={`seat-goal-${player.id}`}
                  title={`${goal.symbol} ${goal.label}`}
                >
                  {goal.symbol} {goal.label}
                </span>
              )}
            </span>
            {onSelect === undefined ? null : (
              <button
                type="button"
                className={styles.seatHit}
                aria-label={t("{name} の席をえらぶ", { name: nameOf(player.id) })}
                onClick={() => onSelect(player.id)}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
