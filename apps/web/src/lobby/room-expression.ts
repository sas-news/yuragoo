// Creature expression derivation (Task 41): the rig supports five
// expressions (rest/hesitating/engaged/bored/adhering) but the arena
// pinned "rest" forever — only the post flicker ever showed anything
// else. The latest landed distribution IS the evaluator's verdict, so
// the face reads the same numbers the body leans on:
//   dominating  -> adhering (it has latched onto one answer)
//   leaning     -> engaged  (interested, moving somewhere)
//   flat + stale-> bored    (nothing convincing anyone)
//   flat + fresh-> hesitating (genuinely torn right now)
//   no verdict  -> rest
import type { CreatureExpression } from "@yuragoo/creature";
import type { DecisionDistribution } from "@yuragoo/protocol";

// Distribution shape thresholds — the flat-margin keeps rounding noise
// from flagging boredom on an almost-uniform pull.
const ADHERING_MIN = 0.78;
const ENGAGED_MIN = 0.5;
const FLAT_MARGIN = 0.05;
// How long a flat verdict must sit unread before it reads as boredom:
// roughly one turn window — a live match in round 1+ qualifies too.
const BORED_IDLE_MS = 15_000;

export const expressionFor = (
  dist: readonly DecisionDistribution[] | null,
  choiceCount: number,
  idleMs: number,
  round: number,
): CreatureExpression => {
  if (dist === null || dist.length === 0 || choiceCount <= 0) return "rest";
  const top = Math.max(...dist.map((d) => d.probability));
  const uniform = 1 / choiceCount;
  if (top >= ADHERING_MIN) return "adhering";
  if (top >= ENGAGED_MIN) return "engaged";
  if (top < uniform + FLAT_MARGIN && (idleMs >= BORED_IDLE_MS || round >= 1)) return "bored";
  return "hesitating";
};
