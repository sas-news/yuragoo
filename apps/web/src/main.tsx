import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { platformKind } from "./platform/bootstrap";
import "./styles.css";
import "./styles/responsive.css";

const devEnabled = import.meta.env.DEV || import.meta.env.MODE === "e2e";
// Task 20 e2e seam: the room bridge exists ONLY in the e2e bundle — the
// dynamic import is dropped from production builds entirely.
if (import.meta.env.MODE === "e2e") {
  void import("./net/room-bridge").then((m) => m.mountRoomBridge());
  // Task 34: adapter specs drive bootPlatform/watchLayout straight — no
  // Discord build in the e2e bundle either, just the injected SDK fake.
  void import("./platform/bootstrap").then((m) => {
    void import("@yuragoo/platform").then((p) => {
      window.__yuragooPlatform = {
        bootPlatform: m.bootPlatform,
        watchLayout: p.watchLayout,
        DISCORD_EVENTS: p.DISCORD_EVENTS,
      };
    });
  });
}
// Task 34: inside a Discord Activity the root path boots the gate — the
// SDK auth chain and instance join run before any game UI mounts.
const DiscordGatePage =
  platformKind() === "discord"
    ? lazy(() => import("./platform/DiscordGate").then((m) => ({ default: m.DiscordGate })))
    : null;
const ShowcasePage = devEnabled ? lazy(() => import("./dev/Showcase")) : null;
const CreatureLabPage = devEnabled ? lazy(() => import("./dev/CreatureLab")) : null;
const DecisionLabPage = devEnabled ? lazy(() => import("./dev/DecisionLab")) : null;
const GameDevPage = devEnabled ? lazy(() => import("./dev/GameDev")) : null;
// /play is product code — a real route in every build mode.
const PlayPage = lazy(() => import("./local/LocalSession"));
// /r/<roomId> is the product room route (Task 24 lobby + in-room view) —
// real in every build mode, lazy like the other pages.
const RoomPage = lazy(() => import("./lobby/RoomPage"));

const el = document.getElementById("root");
if (!el) {
  throw new Error("root element missing");
}
// devEnabled is a build-time constant — production minification drops the
// whole chain, so /dev route literals never reach the prod bundle.
const DevPage = !devEnabled
  ? null
  : window.location.pathname === "/dev/showcase"
    ? ShowcasePage
    : window.location.pathname === "/dev/creature"
      ? CreatureLabPage
      : window.location.pathname === "/dev/decision"
        ? DecisionLabPage
        : window.location.pathname === "/dev/game"
          ? GameDevPage
          : null;
const Page =
  window.location.pathname === "/play"
    ? PlayPage
    : window.location.pathname.startsWith("/r/")
      ? RoomPage
      : DevPage;
// The Discord application id is build config, not a secret (it ships in
// the Activity URL anyway). e2e bundles get a deterministic dummy so the
// adapter spec can drive the full gate without a real app id.
const ClientId =
  import.meta.env.VITE_DISCORD_CLIENT_ID ??
  (import.meta.env.MODE === "e2e" ? "e2e-client" : "");
createRoot(el).render(
  <StrictMode>
    {Page ? (
      <Suspense fallback={<main>読み込み中…</main>}>
        <Page />
      </Suspense>
    ) : DiscordGatePage !== null ? (
      <DiscordGatePage clientId={ClientId} />
    ) : (
      <App />
    )}
  </StrictMode>,
);
