// Task 28 visual-qa spec: real flow screens captured at 375/768/1280 —
// home, armed lobby, in-game input dock and the result overlay — into the
// task evidence directory for the visual review.
import { test, type BrowserContext } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  armContent,
  EVIDENCE_DIR,
  newPage,
  pickAndSee,
  playMatch,
  seat,
  turnOwner,
} from "./full-flow-helpers";
import { API, createRoom, waitMemberCount, waitReadyCount } from "./helpers";
import { type JevFixture, startJevFixture } from "../rooms/mp-fixture";

const API_Q = `api=${encodeURIComponent(API)}&hb=250`;
const WIDTHS = [375, 768, 1280] as const;
const contexts: BrowserContext[] = [];
let jev: JevFixture;
test.beforeAll(async () => {
  jev = await startJevFixture();
});
test.afterAll(async () => {
  for (const c of contexts.splice(0)) await c.close().catch(() => {});
  await jev?.close();
});

test("visual: full-flow screens at 375/768/1280", async ({ browser }) => {
  test.setTimeout(180_000);
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const home = await newPage(browser, contexts);
  const room = await createRoom();
  const host = await seat(browser, contexts, room.roomId, room.inviteSecret, "ホスト");
  const member = await seat(browser, contexts, room.roomId, room.inviteSecret, "メンバー");
  await waitMemberCount(host, 2);
  await armContent(host, member, 2);
  const arm = async (): Promise<void> => {
    for (const p of [host, member]) await p.getByRole("button", { name: "準備OKにする" }).click();
    await waitReadyCount(host, 2);
  };
  await arm();
  await pickAndSee(host, member, "1"); // settings change -> ready reset
  await arm();
  await home.goto(`/?${API_Q}`);
  for (const w of WIDTHS) {
    await home.setViewportSize({ width: w, height: 800 });
    await home.screenshot({ path: join(EVIDENCE_DIR, `task-28-home-${w}.png`) });
    await host.setViewportSize({ width: w, height: 800 });
    await host.screenshot({ path: join(EVIDENCE_DIR, `task-28-lobby-${w}.png`) });
  }
  await host.getByRole("button", { name: "はじめる" }).click();
  await host.locator("[data-turn-player]").waitFor({ timeout: 20_000 });
  const actor = await turnOwner([host, member]);
  for (const w of WIDTHS) {
    await actor.setViewportSize({ width: w, height: 800 });
    await actor.screenshot({ path: join(EVIDENCE_DIR, `task-28-game-${w}.png`) });
  }
  await playMatch([host, member]);
  for (const w of WIDTHS) {
    await host.setViewportSize({ width: w, height: 800 });
    await host.screenshot({ path: join(EVIDENCE_DIR, `task-28-result-${w}.png`) });
  }
});
