// Task 24 e2e helpers: real /r/<id> product pages against the real
// wrangler worker (not the dev bridge). Waits are DOM/state probes only —
// no wall-clock assertions.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";

export const API = "http://127.0.0.1:8787";

export const createRoom = async (): Promise<{ roomId: string; inviteSecret: string }> => {
  const res = await fetch(`${API}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error(`create room failed: ${res.status}`);
  return (await res.json()) as { roomId: string; inviteSecret: string };
};

// ?api points the page at the wrangler worker; ?hb compresses the presence
// heartbeat to the test lease; ?name skips the name panel deterministically.
export const roomUrl = (roomId: string, secret: string, name: string): string =>
  `/r/${roomId}?api=${encodeURIComponent(API)}&hb=250&name=${encodeURIComponent(name)}#${secret}`;

export const joinPage = async (
  page: Page,
  roomId: string,
  secret: string,
  name: string,
): Promise<void> => {
  await page.goto(roomUrl(roomId, secret, name));
  await page.waitForSelector("[data-player-id]", { timeout: 20_000 });
};

export const waitMemberCount = (page: Page, n: number): Promise<unknown> =>
  page.waitForFunction(
    (count) => document.querySelectorAll("[data-player-id]").length === count,
    n,
    { timeout: 20_000 },
  );

export const waitChoiceRows = (page: Page, n: number): Promise<unknown> =>
  page.waitForFunction(
    (count) => document.querySelectorAll("[data-choice-id]").length === count,
    n,
    { timeout: 20_000 },
  );

export const revision = (page: Page): Promise<number> =>
  page.evaluate(
    () =>
      Number(
        document.querySelector("[data-lobby-revision]")?.getAttribute("data-lobby-revision"),
      ) || -1,
  );

export const waitRevision = (page: Page, rev: number): Promise<unknown> =>
  page.waitForFunction(
    (r) =>
      Number(
        document.querySelector("[data-lobby-revision]")?.getAttribute("data-lobby-revision"),
      ) >= r,
    rev,
    { timeout: 20_000 },
  );

export const waitReadyCount = (page: Page, n: number): Promise<unknown> =>
  page.waitForFunction(
    (count) => document.querySelectorAll("[data-player-id][data-ready]").length === count,
    n,
    { timeout: 20_000 },
  );

export const waitOrphanCount = (page: Page, n: number): Promise<unknown> =>
  page.waitForFunction(
    (count) => document.querySelectorAll("[data-choice-id][data-orphan]").length === count,
    n,
    { timeout: 20_000 },
  );

// Host edits flow through the real inputs; propagation to a member page is
// the deterministic "the server took it" signal.
export const waitScenarioOn = (page: Page, text: string): Promise<unknown> =>
  page.waitForFunction(
    (t) => document.querySelector('section[aria-label="シナリオ"]')?.textContent?.includes(t),
    text,
    { timeout: 20_000 },
  );

export const waitChoiceLabelOn = (page: Page, choiceId: string, text: string): Promise<unknown> =>
  page.waitForFunction(
    ({ id, t }) => document.querySelector(`[data-choice-id="${id}"]`)?.textContent?.includes(t),
    { id: choiceId, t: text },
    { timeout: 20_000 },
  );

// Raw command access on the page's own RoomConnection (e2e-only seam) —
// used for rejection paths a well-behaved UI never produces.
export const sendRaw = (page: Page, type: string, payload: unknown): Promise<unknown> =>
  page.evaluate(
    ({ t, p }) => {
      const conn = (
        window as unknown as {
          __roomConn?: { send(ty: string, pa: unknown): Promise<unknown> };
        }
      ).__roomConn;
      if (conn === undefined) return Promise.reject(new Error("no conn"));
      return conn.send(t, p);
    },
    { t: type, p: payload },
  );

export const sendRawError = async (page: Page, type: string, payload: unknown): Promise<string> => {
  try {
    await sendRaw(page, type, payload);
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\.\d+Z$/, "Z");
export const EVIDENCE_DIR = join(
  process.cwd(),
  ".omo/evidence/yuragoo-development",
  `${stamp}-t24`,
);

export const writeEvidence = (name: string, data: unknown): void => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(
    join(EVIDENCE_DIR, name),
    typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`,
  );
};
