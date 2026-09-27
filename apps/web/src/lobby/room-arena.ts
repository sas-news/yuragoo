// Room-arena presentation adapters: fold the synchronized RoomView into
// the shapes the shared game components expect — attraction samples for
// the creature (committed choice i rides canonical slot i, same as /play),
// and the flat HudSnapshot for the HUD strip. All data is server-folded in
// room-view.ts; nothing here fabricates game authority.
import { type AttractionSample, CANONICAL_SLOT_ANGLES, PULL_GAIN } from "@yuragoo/creature";
import { orderForRound } from "@yuragoo/game-core";
import type { DecisionDistribution, ServerEnvelope } from "@yuragoo/protocol";
import type { HudSnapshot } from "../game/hud-types";
import { SLOT_SYMBOLS } from "../game/slots";
import type { RoomView } from "./room-view";
import { memberName } from "./view-members";

// The newest evaluated post's distribution — the creature chases the
// latest verdict, exactly like the local loop.
export const latestRoomDist = (view: RoomView): readonly DecisionDistribution[] | null => {
  for (let i = view.posts.length - 1; i >= 0; i -= 1) {
    const post = view.posts[i];
    if (post === undefined || post.status !== "evaluated") continue;
    const dist = view.dists.get(post.postId);
    if (dist !== undefined) return dist;
  }
  return null;
};

// The committed choice prefix length — startGame commits exactly
// rosterSize choices, and view.roster IS that roster (folded from the
// "started" event or a snapshot, so it is populated the moment the game
// begins). The lobby ledger's committedCount is a pre-start fallback: it
// stays 0 through live play because no lobbyChanged row rides the start
// commit. An empty choice prefix would make every dist lookup miss —
// uniform pull, creature glued to the center.
export const committedCount = (view: RoomView): number =>
  view.roster.length > 0 ? view.roster.length : view.lobby.committedCount;

const committedChoices = (view: RoomView): readonly { choiceId: string; label: string }[] =>
  view.lobby.choices.slice(0, committedCount(view));

// Attraction samples for the creature: committed choice i sits on slot i's
// canonical angle; a missing distribution reads as a uniform pull.
// PULL_GAIN lives in @yuragoo/creature: story panels replay poses with the
// same cubing, so live lean and captured silhouette always match.
export const roomSamples = (
  distribution: readonly DecisionDistribution[] | null,
  view: RoomView,
): readonly AttractionSample[] => {
  const count = Math.min(6, Math.max(2, committedCount(view)));
  const choices = committedChoices(view);
  // The attractor layer keys its markers off the SAME sample count, so the
  // pull direction always lands on a visible post (roster size can differ
  // from the committed count in the started/lobbyChanged tick).
  const angles = CANONICAL_SLOT_ANGLES[count] ?? [];
  const fallback = count > 0 ? 1 / count : 0;
  const raw = Array.from(
    { length: count },
    (_, i) =>
      distribution?.find((d) => d.choiceId === choices[i]?.choiceId)?.probability ?? fallback,
  );
  const shaped = raw.map((w) => w ** PULL_GAIN);
  const total = shaped.reduce((sum, w) => sum + w, 0);
  return raw.map((_, i) => ({
    angleRad: angles[i] ?? 0,
    weight: (shaped[i] ?? 0) / (total > 0 ? total : 1),
  }));
};

// The HUD's flat snapshot: turn order recomputed per round (the pointer
// event only carries playerId+round), deadline on the server clock.
export const roomHud = (view: RoomView): HudSnapshot => {
  const settings = view.state?.settings;
  const mode = settings?.mode ?? view.lobby.settings.mode;
  const rounds = settings?.rounds ?? view.lobby.settings.rounds;
  const turnSeconds = settings?.turnSeconds ?? view.lobby.settings.turnSeconds;
  const liveSeconds = settings?.liveSeconds ?? view.lobby.settings.liveSeconds;
  const round = view.turn?.round ?? 0;
  const hostId = settings?.hostId ?? view.hostPlayerId ?? undefined;
  const turnOrder = orderForRound(view.roster, round, hostId);
  const turnIndex = view.turn === null ? 0 : Math.max(0, turnOrder.indexOf(view.turn.playerId));
  return {
    phase: view.phase,
    mode,
    round,
    rounds,
    turnOrder,
    turnIndex,
    roster: view.roster,
    deadlineAtMs: view.deadlineAtMs ?? 0,
    outcome: view.outcome,
    windowMs: (mode === "turn" ? turnSeconds : liveSeconds) * 1000,
    turnSeconds,
    liveSeconds,
    settleSeconds: settings?.settleSeconds ?? 8,
  };
};

// The HUD's deadline bar needs a server-clock deadline per beat: a turn
// slot re-arms on each turn event, the match on started, the settle
// window on complete. Settings come from the committed game when a
// snapshot carried them, else the lobby ledger.
export const deadlineFor = (view: RoomView, env: ServerEnvelope): number | null => {
  const e = env.type === "phaseChanged" || env.type === "inputAccepted" ? env.payload.event : null;
  if (e === null) return view.deadlineAtMs;
  const mode = view.state?.settings.mode ?? view.lobby.settings.mode;
  const turnSeconds = view.state?.settings.turnSeconds ?? view.lobby.settings.turnSeconds;
  const liveSeconds = view.state?.settings.liveSeconds ?? view.lobby.settings.liveSeconds;
  const settleSeconds = view.state?.settings.settleSeconds ?? 8;
  switch (e.type) {
    case "turn":
      return env.serverTime + turnSeconds * 1000;
    case "started":
      return env.serverTime + (mode === "live" ? liveSeconds : turnSeconds) * 1000;
    case "complete":
      return env.serverTime + settleSeconds * 1000;
    case "finished":
      return env.serverTime;
    default:
      return view.deadlineAtMs;
  }
};

// Per-slot goal chips for PlayerSeats: slot symbol + committed choice
// label, indexed by slot like the local goals.
export const roomGoals = (
  view: RoomView,
): readonly { readonly symbol: string; readonly label: string }[] =>
  committedChoices(view).map((c, i) => ({ symbol: SLOT_SYMBOLS[i] ?? "?", label: c.label }));

// The seat a landed verdict pulled toward: the slot with the highest
// normalized weight in the newest distribution. Ties resolve to the
// earlier slot (stable, matches "引き分け気味" reads) — a null dist or an
// all-flat pull yields undefined (no arrow for "nowhere").
export const pulledSlot = (
  distribution: readonly DecisionDistribution[] | null,
  view: RoomView,
): number | null => {
  if (distribution === null) return null;
  const choices = committedChoices(view);
  let bestSlot: number | null = null;
  let best = 0;
  for (const d of distribution) {
    const slot = choices.findIndex((c) => c.choiceId === d.choiceId);
    if (slot >= 0 && d.probability > best) {
      best = d.probability;
      bestSlot = slot;
    }
  }
  // A flat pull (max weight <= uniform share) isn't a direction — no cue.
  return bestSlot !== null && best > 1 / Math.max(1, choices.length) ? bestSlot : null;
};

// The corner log renders the room's event stream (joins, turns, posts,
// result) — posts carry their text so the log doubles as the feed.
export const roomEventLine = (env: ServerEnvelope, view: RoomView): string => {
  const name = (id: string): string => memberName(view.players, id);
  switch (env.type) {
    case "phaseChanged":
    case "inputAccepted": {
      const e = env.payload.event;
      switch (e.type) {
        case "started":
          return "ゲーム開始";
        case "turn":
          return `${name(e.playerId)} のターン（${e.round + 1}巡目）`;
        case "passed":
          return `${name(e.playerId)} がパス`;
        case "posted": {
          const post = env.type === "inputAccepted" ? env.payload.post : undefined;
          return post === undefined
            ? `${name(e.playerId)} が投稿`
            : `${name(e.playerId)}：${post.text}`;
        }
        case "complete":
          return "締め切り — 集計中";
        case "end-requested":
          return `${name(e.playerId)} が終了リクエスト`;
        case "finished":
          return "終了";
        default:
          return env.type; // exhaustive game-event union — unreachable
      }
    }
    case "memberJoined":
      return `${env.payload.displayName ?? name(env.payload.playerId)} が入室`;
    case "lobbyChanged":
      // Never pushed to the feed (applyEvent filters it) — kept so a
      // replayed ledger line still renders something sane.
      return "ロビー情報が更新されました";
    case "lobbyReopened":
      return "ロビーに戻りました";
    case "memberLeft":
      return `${name(env.payload.playerId)} が退出`;
    case "presenceChanged":
      return `${name(env.payload.playerId)} が${env.payload.connected ? "接続" : "切断"}`;
    case "hostChanged":
      return `ホストが ${name(env.payload.playerId)} に`;
    case "decisionUpdated":
      return "生きものがかたよりました";
    case "decisionFailed":
      return "生きもののこたえがもらえなかった…";
    case "endingReady":
      return env.payload.generated
        ? "おわりの紙芝居ができました"
        : "おわりの紙芝居を用意しています";
    case "roomClosed":
      return "へやが閉じられました";
    default:
      return env.type;
  }
};
