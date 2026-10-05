// Discord shelf video preview (640x360 mp4, <=10s, <=0.5MB): three clips —
// REAL creature footage from /dev/creature (weights driven live through
// __YURAGOO_LAB_E2E__), live /play footage, end card with the URL. Each
// clip is a separate Playwright video; ffmpeg concatenates and encodes.
// Requires the e2e `vite preview` on :4180 for /dev/creature and /play.
import { chromium } from "playwright";
import { execSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cap, FONT, FONT_LINK } from "./creature.mjs";

const brandDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const videoDir = resolve(brandDir, "raw-video");
mkdirSync(videoDir, { recursive: true });
for (const f of readdirSync(videoDir, { withFileTypes: true }))
  if (f.isFile()) unlinkSync(join(videoDir, f.name));

const W = 640;
const H = 360;
const browser = await chromium.launch();

const clip = async (name, run, { speed = 1, skip = 0 } = {}) => {
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    recordVideo: { dir: videoDir, size: { width: W, height: H } },
  });
  const page = await ctx.newPage();
  const video = page.video();
  await run(page);
  await ctx.close();
  const webm = await video.path();
  const fixed = join(videoDir, `${name}.mp4`);
  const vf = `setpts=${speed}*PTS,scale=${W}:${H}`;
  execSync(
    `ffmpeg -y ${skip > 0 ? `-ss ${skip}` : ""} -i "${webm}" -vf "${vf}" -c:v libx264 -crf 30 -an "${fixed}"`,
  );
  console.log("clip", name);
};

const card = (inner, anim = "") => `${FONT_LINK}<style>
  body{margin:0;width:${W}px;height:${H}px;background:#fff7e8;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:${FONT};overflow:hidden}
  .wob{animation:wob 2.2s ease-in-out infinite}
  @keyframes wob{0%,100%{transform:scaleX(1) scaleY(1)}45%{transform:scaleX(1.14) scaleY(.92)}}
  .in{animation:in .55s ease-out both}
  @keyframes in{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}
  ${anim}
</style><body>${inner}</body>`;

// Clip A — real creature on /dev/creature: hide the lab controls, fill the
// viewport with the stage, drive a rest→pull→rest beat, and overlay the
// title. The stretch is the genuine renderer deformation.
await clip("a-title", async (page) => {
  await page.goto("http://localhost:4180/dev/creature", { waitUntil: "networkidle" });
  await page.waitForFunction(() => window.__YURAGOO_LAB_E2E__ !== undefined);
  await page.addStyleTag({
    content: `main[class] > *:not([class*=stageWrap]){display:none!important}
      [class*=stageWrap]{position:fixed!important;inset:0!important;width:100%!important;height:100%!important}`,
  });
  await page.evaluate(() => {
    document.body.insertAdjacentHTML(
      "beforeend",
      `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=M+PLUS+Rounded+1c:wght@700;800&display=swap">
      <div id="cap-title" style="position:fixed;left:0;right:0;bottom:18px;text-align:center;
        font-family:'M PLUS Rounded 1c',sans-serif;font-size:56px;font-weight:800;color:#402f3b;
        text-shadow:0 2px 0 #fff7e8;opacity:0;transition:opacity .4s">ゆらぐー！</div>`,
    );
  });
  const set = (w, e) => page.evaluate(([a, b]) => window.__YURAGOO_LAB_E2E__.set(a, b), [w, e]);
  await set([25, 25, 25, 25], "rest");
  await page.waitForTimeout(950);
  await page.evaluate(() => {
    document.getElementById("cap-title").style.opacity = "1";
  });
  await set([8, 72, 12, 8], "engaged");
  await page.waitForTimeout(750);
  await set([25, 25, 25, 25], "rest");
  await page.waitForTimeout(400);
});

// Clip B — real /play: three seats throw words, creature gets pulled.
await clip(
  "b-play",
  async (page) => {
    await page.goto("http://localhost:4180/play?mode=live&players=4&live=20", {
      waitUntil: "networkidle",
    });
    await page.getByRole("button", { name: "はじめる" }).click();
    await page.waitForTimeout(1400);
    const input = page.getByTestId("game-input");
    const send = page.getByTestId("send-button");
    const seats = page.locator('button[aria-label*="の席をえらぶ"]');
    for (const [seat, text] of [
      [0, "プリンたべたい！"],
      [1, "しょっぱいのもいい"],
      [2, "はやくたべよ〜"],
    ]) {
      await seats.nth(seat).click();
      await input.click();
      await input.pressSequentially(text, { delay: 45 });
      await send.click();
      await page.waitForTimeout(800);
    }
    await page.waitForTimeout(400);
  },
  { speed: 0.55, skip: 1.0 },
);

// Clip C — end card: real resting creature + CTA + URL.
await clip("c-end", async (page) => {
  await page.setContent(
    card(`<div style="display:flex;align-items:center;gap:22px">
        <img src="${cap("rest")}" width="170" height="170" class="wob" style="transform-origin:50% 60%;display:block"/>
        <div class="in">
          <div style="font-size:34px;font-weight:800;color:#402f3b">2〜6人であそべるよ</div>
          <div style="font-size:22px;font-weight:700;color:#1f8f74;margin-top:8px">yuragoo.sasnews.dev</div>
        </div>
      </div>`),
  );
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(850);
});

await browser.close();

const list = join(videoDir, "list.txt");
writeFileSync(list, ["a-title", "b-play", "c-end"].map((n) => `file '${n}.mp4'`).join("\n"));
const out = resolve(brandDir, "preview-640x360.mp4");
execSync(
  `ffmpeg -y -f concat -safe 0 -i "${list}" -vf "scale=${W}:${H}" -c:v libx264 -preset slow -crf 28 -movflags +faststart -an "${out}"`,
);
const kb = Math.round(statSync(out).size / 1024);
console.log(`wrote preview-640x360.mp4 (${kb} KB)`);
if (kb > 512) console.warn("over Discord's 0.5MB cap — raise crf");
