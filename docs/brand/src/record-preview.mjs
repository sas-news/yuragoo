// Discord shelf video preview (640x360 mp4, <=10s, <=0.5MB): three clips —
// animated title card, live /play footage (three seats pull the creature
// with words), end card with the URL. Each clip is a separate Playwright
// video; ffmpeg concatenates and encodes the final mp4.
// Requires `vite preview` on :4180 (built dist) for the gameplay clip.
import { chromium } from "playwright";
import { execSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { creature, FONT, FONT_LINK } from "./creature.mjs";

const brandDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const videoDir = resolve(brandDir, "raw-video");
mkdirSync(videoDir, { recursive: true });
for (const f of readdirSync(videoDir)) unlinkSync(join(videoDir, f));

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

// Clip A — title card: creature gently stretches on a loop.
await clip("a-title", async (page) => {
  await page.setContent(
    card(`<svg width="230" height="230" viewBox="0 40 512 440" class="wob" style="transform-origin:50% 60%">${creature("v", 0, 0, 1, { sx: 1.25, sy: 0.88 })}</svg>
      <div class="in" style="font-size:64px;font-weight:800;color:#402f3b">ゆらぐー！</div>`),
  );
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1400);
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
  { speed: 0.62, skip: 1.0 },
);

// Clip C — end card: creature + CTA + URL.
await clip("c-end", async (page) => {
  await page.setContent(
    card(`<div style="display:flex;align-items:center;gap:22px">
        <svg width="180" height="180" viewBox="0 40 512 440" class="wob" style="transform-origin:50% 60%">${creature("e", 0, 0, 1, { sx: 1.18, sy: 0.9 })}</svg>
        <div class="in">
          <div style="font-size:34px;font-weight:800;color:#402f3b">2〜6人であそべるよ</div>
          <div style="font-size:22px;font-weight:700;color:#1f8f74;margin-top:8px">yuragoo.sasnews.dev</div>
        </div>
      </div>`),
  );
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1100);
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
