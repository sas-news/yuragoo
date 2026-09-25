import { useEffect, useRef, useState } from "react";
import {
  type BodySummary,
  type CreatureRuntime,
  readRendererDiagnostics,
  type RendererDiagnostics,
  type SceneLayoutSummary,
  type StageVisualState,
} from "@yuragoo/creature";
import { CreatureStage } from "../game/CreatureStage";
import styles from "./Showcase.module.css";

declare global {
  interface Window {
    __YURAGOO_E2E__?: {
      diagnostics(): RendererDiagnostics;
      extractBodySummary(): BodySummary;
      readLayoutSummary(): SceneLayoutSummary;
    };
  }
}

const STATES = [
  { id: "normal", label: "ふつう" },
  { id: "focus", label: "フォーカス" },
  { id: "loading", label: "読み込み中" },
  { id: "error", label: "エラー" },
] as const;

export default function Showcase() {
  const params = new URLSearchParams(window.location.search);
  const initDelay = Number(params.get("initDelay") ?? "0");
  const forceUnsupported = params.get("forceUnsupported") === "1";
  const [visualState, setVisualState] = useState<StageVisualState>("normal");
  const [mounted, setMounted] = useState(true);
  const runtimeRef = useRef<CreatureRuntime | null>(null);
  const renderCount = useRef(0);
  renderCount.current += 1;

  useEffect(() => {
    window.__YURAGOO_E2E__ = {
      diagnostics: () => readRendererDiagnostics(),
      extractBodySummary: () => {
        const runtime = runtimeRef.current;
        if (!runtime) throw new Error("runtime not ready");
        return runtime.extractBodySummary();
      },
      readLayoutSummary: () => {
        const runtime = runtimeRef.current;
        if (!runtime) throw new Error("runtime not ready");
        return runtime.readLayoutSummary();
      },
    };
    return () => {
      delete window.__YURAGOO_E2E__;
    };
  }, []);

  return (
    <main className={styles.page}>
      <h1>ゆらぐー！描画ショーケース</h1>
      <div className={styles.controls}>
        {STATES.map((state) => (
          <button
            key={state.id}
            type="button"
            data-testid={`state-${state.id}`}
            aria-pressed={visualState === state.id}
            onClick={() => setVisualState(state.id)}
          >
            {state.label}
          </button>
        ))}
        <button
          type="button"
          data-testid="toggle-mount"
          onClick={() => setMounted((value) => !value)}
        >
          {mounted ? "アンマウント" : "マウント"}
        </button>
      </div>
      <div className={styles.stageWrap}>
        {mounted ? (
          <CreatureStage
            visualState={visualState}
            {...(initDelay > 0 ? { initializationDelayMs: initDelay } : {})}
            {...(forceUnsupported ? { forceUnsupported: true } : {})}
            onReady={(runtime) => {
              runtimeRef.current = runtime;
            }}
          />
        ) : null}
      </div>
      <p data-testid="state-label" data-state={visualState}>
        状態: {visualState} / {mounted ? "マウント中" : "アンマウント中"}
      </p>
      <span data-testid="render-count" data-count={renderCount.current}>
        renders: {renderCount.current}
      </span>
    </main>
  );
}
