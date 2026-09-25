import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type AttractionSample,
  CANONICAL_SLOT_ANGLES,
  type CreatureExpression,
  type CreatureRuntime,
  type PoseRenderSummary,
  readRendererDiagnostics,
  type RendererDiagnostics,
  type SceneLayoutSummary,
} from "@yuragoo/creature";
import { CreatureStage } from "../game/CreatureStage";
import styles from "./CreatureLab.module.css";

declare global {
  interface Window {
    __YURAGOO_LAB_E2E__?: {
      set(
        weights: readonly number[],
        expression: CreatureExpression,
        reducedMotion?: boolean,
      ): void;
      pose(): PoseRenderSummary;
      layout(): SceneLayoutSummary;
      diagnostics(): RendererDiagnostics;
    };
  }
}

const COUNT_OPTIONS = [2, 4, 6] as const;
const IDS = ["A", "B", "C", "D", "E", "F"] as const;
const SYMBOLS = ["○", "◇", "△", "□", "☆", "⬡"] as const;
const EXPRESSIONS: readonly { id: CreatureExpression; label: string }[] = [
  { id: "rest", label: "ふつう" },
  { id: "hesitating", label: "ためらい" },
  { id: "engaged", label: "夢中" },
  { id: "bored", label: "退屈" },
  { id: "adhering", label: "吸着" },
];

interface ScriptStep {
  readonly weights: readonly number[];
  readonly expression: CreatureExpression;
}
const SCRIPTS: readonly { id: string; label: string; steps: readonly ScriptStep[] }[] = [
  {
    id: "reversal",
    label: "A→B逆転",
    steps: [
      { weights: [0.8, 0.1, 0.05, 0.05], expression: "engaged" },
      { weights: [0.25, 0.25, 0.25, 0.25], expression: "rest" },
      { weights: [0.05, 0.8, 0.1, 0.05], expression: "engaged" },
    ],
  },
  {
    id: "tug",
    label: "A/B拮抗",
    steps: [
      { weights: [0.8, 0.1, 0.05, 0.05], expression: "engaged" },
      { weights: [0.45, 0.45, 0.05, 0.05], expression: "hesitating" },
      { weights: [0.05, 0.8, 0.1, 0.05], expression: "engaged" },
    ],
  },
  {
    id: "even",
    label: "均等",
    steps: [
      { weights: [0.8, 0.1, 0.05, 0.05], expression: "engaged" },
      { weights: [0.25, 0.25, 0.25, 0.25], expression: "rest" },
      { weights: [0.25, 0.25, 0.25, 0.25], expression: "rest" },
    ],
  },
  {
    id: "adhere",
    label: "吸着直前→反転",
    steps: [
      { weights: [0.8, 0.1, 0.05, 0.05], expression: "adhering" },
      { weights: [0.8, 0.1, 0.05, 0.05], expression: "adhering" },
      { weights: [0.05, 0.8, 0.1, 0.05], expression: "engaged" },
    ],
  },
];

export default function CreatureLab() {
  const [count, setCount] = useState(4);
  const [weights, setWeights] = useState<readonly number[]>([52, 18, 18, 12, 10, 10]);
  const [expression, setExpression] = useState<CreatureExpression>("rest");
  const [reduced, setReduced] = useState(false);
  const [scriptStatus, setScriptStatus] = useState<"idle" | "running" | "complete">("idle");
  const runtimeRef = useRef<CreatureRuntime | null>(null);
  const timersRef = useRef<number[]>([]);

  const apply = useCallback((next: readonly number[], expr: CreatureExpression): void => {
    setCount(next.length);
    setWeights((prev) => prev.map((_, i) => (i < next.length ? (next[i] ?? 0) * 100 : 0)));
    setExpression(expr);
  }, []);

  useEffect(() => {
    window.__YURAGOO_LAB_E2E__ = {
      set: (w, expr, rm) => {
        if (![2, 4, 6].includes(w.length)) {
          throw new RangeError("weights length must be 2, 4 or 6");
        }
        for (const value of w) {
          if (!Number.isFinite(value) || value < 0) {
            throw new RangeError("weights must be finite numbers >= 0");
          }
        }
        apply(w, expr);
        if (rm !== undefined) setReduced(rm);
      },
      pose: () => {
        const runtime = runtimeRef.current;
        if (!runtime) throw new Error("runtime not ready");
        return runtime.readPoseSummary();
      },
      layout: () => {
        const runtime = runtimeRef.current;
        if (!runtime) throw new Error("runtime not ready");
        return runtime.readLayoutSummary();
      },
      diagnostics: () => readRendererDiagnostics(),
    };
    const timers = timersRef.current;
    return () => {
      delete window.__YURAGOO_LAB_E2E__;
      for (const timer of timers) clearTimeout(timer);
    };
  }, [apply]);

  const angles = CANONICAL_SLOT_ANGLES[count] ?? CANONICAL_SLOT_ANGLES[4] ?? [];
  const samples = useMemo<readonly AttractionSample[]>(
    () =>
      weights
        .slice(0, count)
        .map((weight, i) => ({ angleRad: angles[i] ?? 0, weight: weight / 100 })),
    [weights, count, angles],
  );
  const presentation = useMemo(
    () => ({ samples, expression, reducedMotion: reduced }),
    [samples, expression, reduced],
  );

  const runScript = (steps: readonly ScriptStep[]): void => {
    for (const timer of timersRef.current) clearTimeout(timer);
    timersRef.current = [];
    setScriptStatus("running");
    steps.forEach((step, index) => {
      timersRef.current.push(
        window.setTimeout(() => apply(step.weights, step.expression), index * 1000),
      );
    });
    timersRef.current.push(window.setTimeout(() => setScriptStatus("complete"), 3000));
  };

  return (
    <main className={styles.page}>
      <h1>クリーチャーラボ</h1>
      <div className={styles.stageWrap}>
        <CreatureStage
          visualState="normal"
          presentation={presentation}
          onReady={(runtime) => {
            runtimeRef.current = runtime;
          }}
        />
      </div>
      <section className={styles.group} aria-label="選択肢の数">
        {COUNT_OPTIONS.map((n) => (
          <button
            key={n}
            type="button"
            data-testid={`count-${n}`}
            aria-pressed={count === n}
            onClick={() => setCount(n)}
          >
            {n}択
          </button>
        ))}
      </section>
      <section className={styles.sliders} aria-label="各選択肢への引力">
        {IDS.slice(0, count).map((id, i) => (
          <label key={id} className={styles.sliderRow} data-lab-slider={id}>
            <span className={styles.symbol}>
              {SYMBOLS[i]} {id}
            </span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={weights[i] ?? 0}
              aria-label={`選択肢${id}への引力`}
              onChange={(event) =>
                setWeights((prev) =>
                  prev.map((value, j) => (j === i ? Number(event.target.value) : value)),
                )
              }
            />
            <output className={styles.value}>{weights[i] ?? 0}</output>
          </label>
        ))}
      </section>
      <section className={styles.group} aria-label="表情">
        {EXPRESSIONS.map((expr) => (
          <button
            key={expr.id}
            type="button"
            data-testid={`expr-${expr.id}`}
            aria-pressed={expression === expr.id}
            onClick={() => setExpression(expr.id)}
          >
            {expr.label}
          </button>
        ))}
      </section>
      <label className={styles.checkbox}>
        <input
          type="checkbox"
          data-testid="reduced-motion"
          checked={reduced}
          onChange={(event) => setReduced(event.target.checked)}
        />
        動きを減らす
      </label>
      <section className={styles.group} aria-label="スクリプト">
        {SCRIPTS.map((script) => (
          <button
            key={script.id}
            type="button"
            data-testid={`script-${script.id}`}
            onClick={() => runScript(script.steps)}
          >
            {script.label}
          </button>
        ))}
      </section>
      <p className={styles.status} data-testid="script-status" data-script-status={scriptStatus}>
        script: {scriptStatus}
      </p>
    </main>
  );
}
