// Attractor-anchored player table: each player's chip is planted on their
// attractor post — the marker the creature pulls toward. Positions arrive
// pre-computed in arena px (see seats.ts); chips are centered on the anchor
// via translate(-50%,-50%). The current player's chip pulses a slot-colored
// ring — the glow IS the turn indicator (the HUD turn line stays for a11y).
import type { CSSProperties } from "react";
import type { Player, PlayerId } from "@yuragoo/game-core";
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
}

export function PlayerSeats(props: PlayerSeatsProps) {
  const { roster, positions, currentId, nameOf = (id) => id, goals, onSelect } = props;

  return (
    <ul className={styles.seats} aria-label="プレイヤーの席">
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
            data-current={isCurrent || undefined}
            data-selectable={onSelect !== undefined || undefined}
            aria-label={`${nameOf(player.id)} の席`}
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
              {slotBadge(player.slot)}
            </span>
            <span className={styles.who}>
              <span className={styles.name}>{nameOf(player.id)}</span>
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
                aria-label={`${nameOf(player.id)} の席をえらぶ`}
                onClick={() => onSelect(player.id)}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
