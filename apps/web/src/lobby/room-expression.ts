// Creature expression derivation (Task 41 + Task 43): the rig supports
// five expressions (rest/hesitating/engaged/bored/adhering). Since Task 43
// every Jev eval also answers a mood question — that verdict wins
// outright when present (the model read the actual context, not just the
// distribution shape). The shape heuristic below remains the fallback for
// mood-less verdicts (older rows, mood-less upstreams, local fixtures).
//   dominating  -> adhering (it has latched onto one answer)
//   leaning     -> engaged  (interested, moving somewhere)
//   flat + stale-> bored    (nothing convincing anyone)
//   flat + fresh-> hesitating (genuinely torn right now)
//   no verdict  -> rest
import type { CreatureExpression } from "@yuragoo/creature";
import type { DecisionDistribution, MoodId } from "@yuragoo/protocol";

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
  mood: MoodId | null,
  choiceCount: number,
  idleMs: number,
  round: number,
): CreatureExpression => {
  // Jev's own mood verdict — the face the model picked. MoodId and
  // CreatureExpression share the five ids by construction (protocol owns
  // the wire vocabulary), so the verdict crosses unchanged.
  if (mood !== null) return mood;
  if (dist === null || dist.length === 0 || choiceCount <= 0) return "rest";
  const top = Math.max(...dist.map((d) => d.probability));
  const uniform = 1 / choiceCount;
  if (top >= ADHERING_MIN) return "adhering";
  if (top >= ENGAGED_MIN) return "engaged";
  if (top < uniform + FLAT_MARGIN && (idleMs >= BORED_IDLE_MS || round >= 1)) return "bored";
  return "hesitating";
};
