# Story (kamishibai ending) contract

Task 33 reference. The ending is a 3-5 page picture-story recap of a
finished match: identical panels for every member, self-paced paging,
human posts as the protagonists, generated prose strictly optional.

## Data flow

    events table (seq = eventId)   posts in room_meta.snapshot   lobby ledger
             |                          |                            |
             +---------- buildStory (game-core/story) -----------+
                              |  deterministic, template copy
               ending.panel row + endingReady { generated:false }
                              |
            "post" generation slot (ControlPlane reserve/consume)
                              |  structured panels only, one call
               ending.panel updated + endingReady { generated:true }

## Contracts

- **eventId = events.seq.** Every panel cites the persisted event it
  depicts; `decisionUpdated` rows carry {postId, revision, distribution},
  where revision is the covered post seq (not the event seq).
- **Pull is canonical.** `panel.pull` = raw per-roster-slot probabilities
  (slot order == committed choice order). The client reshapes it
  (PULL_GAIN=3 cube + renormalize, packages/creature/replay-pose.ts) so
  the rendered silhouette equals what the arena showed. null = rest pose.
- **Quotes are verbatim.** `panel.quotes` carries the covered posts' text
  — a grouped evaluation quotes every covered post; the group is never
  credited to its last poster alone.
- **All-or-nothing generation.** The post-game call returns a story title
  plus one caption per panel; partial coverage keeps the whole template
  set (a half-template page reads inconsistent — deliberate).
- **Epoch-scoped.** `gameEpoch` rides the story; rematch bumps it, and
  the write/broadcast path re-verifies phase+epoch inside the commit.

## Budgets and lifetime

- Generation spends the per-game `generation_slots` "post" row —
  at most one call per game, plus the "pre" choice call: <=2/game total.
- Panels, quotes and the story JSON die with the room (`deleteAll` on
  close; `clearGameArtifacts` on rematch/backToLobby). Blobs never leave
  the client; the server only ever sees structured panels, never images.
- Reconnect/resync heals via `snapshot.ending`; ordered `endingReady`
  frames fire at build time and after a successful generation.

## What it is not

- Not a per-player archive: no download/share endpoints exist, and no
  room history survives closeRoom.
- Not a judgement override: the winner is always the server-settled
  outcome; captions describe, they never decide.

