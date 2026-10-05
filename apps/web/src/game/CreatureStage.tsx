import { useEffect, useRef, useState } from "react";
import {
  type CreaturePresentation,
  type CreatureRuntime,
  DEFAULT_PRESENTATION,
  type MountCreatureOptions,
  mountCreatureScene,
  type StageVisualState,
} from "@yuragoo/creature";
import { useLocale, useT } from "../i18n";
import { Status } from "../ui/Status";
import { describeCreature } from "./creatureStatus";
import styles from "./CreatureStage.module.css";

type StageStatus = "initializing" | "ready" | "unsupported";

export interface CreatureStageProps {
  readonly visualState: StageVisualState;
  readonly presentation?: CreaturePresentation;
  readonly initializationDelayMs?: number;
  readonly forceUnsupported?: boolean;
  // Canvas backdrop alpha (default 1 = paper card). 0 lets the creature
  // float over the page backdrop — used by the dark /dev/game stage.
  readonly backgroundAlpha?: number;
  readonly onReady?: (runtime: CreatureRuntime) => void;
  // The pull narrative is over once the outcome lands — hide the corner
  // status line so the "けっかをみる" reopen chip can sit there alone.
  readonly statusHidden?: boolean;
}

export function CreatureStage(props: CreatureStageProps) {
  const { visualState, presentation, initializationDelayMs, forceUnsupported, onReady } = props;
  const { backgroundAlpha, statusHidden } = props;
  const hostRef = useRef<HTMLElement | null>(null);
  const runtimeRef = useRef<CreatureRuntime | null>(null);
  const visualStateRef = useRef(visualState);
  const onReadyRef = useRef(onReady);
  const [status, setStatus] = useState<StageStatus>("initializing");
  const [systemReduced, setSystemReduced] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  visualStateRef.current = visualState;
  onReadyRef.current = onReady;

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setSystemReduced(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const controller = new AbortController();
    const options: MountCreatureOptions = {
      signal: controller.signal,
      visualState: visualStateRef.current,
      ...(initializationDelayMs !== undefined ? { initializationDelayMs } : {}),
      ...(forceUnsupported === true ? { forceUnsupported: true } : {}),
      ...(backgroundAlpha !== undefined ? { backgroundAlpha } : {}),
    };
    setStatus("initializing");
    mountCreatureScene(host, options)
      .then((runtime) => {
        if (controller.signal.aborted) {
          runtime.destroy();
          return;
        }
        runtime.setVisualState(visualStateRef.current);
        runtimeRef.current = runtime;
        setStatus("ready");
        onReadyRef.current?.(runtime);
      })
      .catch(() => {
        if (!controller.signal.aborted) setStatus("unsupported");
      });
    return () => {
      controller.abort();
      runtimeRef.current?.destroy();
      runtimeRef.current = null;
    };
  }, [initializationDelayMs, forceUnsupported, backgroundAlpha]);

  useEffect(() => {
    if (status === "ready") runtimeRef.current?.setVisualState(visualState);
  }, [visualState, status]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (status !== "ready" || !runtime) return;
    const base = presentation ?? DEFAULT_PRESENTATION;
    runtime.setPresentation({
      samples: base.samples,
      expression: base.expression,
      reducedMotion: base.reducedMotion || systemReduced,
    });
  }, [presentation, systemReduced, status]);

  const t = useT();
  const lang = useLocale();
  const choiceCount = (presentation ?? DEFAULT_PRESENTATION).samples.length;
  return (
    <section
      ref={hostRef}
      className={styles.stage}
      data-testid="creature-stage"
      data-state={visualState}
      data-status={status}
      aria-label={t("半透明の生きものが{n}つの選択肢に向かって伸びている様子", {
        n: choiceCount,
      })}
      aria-busy={visualState === "loading"}
    >
      {status === "unsupported" ? (
        <div role="alert" className={styles.alert}>
          {t("このブラウザーでは WebGL が使えないため、ゲームを開始できません。")}
        </div>
      ) : null}
      {visualState === "error" ? (
        <div role="alert" className={styles.errorBadge}>
          <span aria-hidden="true">!</span>
          {t("うまくいきませんでした。もう一度お試しください。")}
        </div>
      ) : null}
      {status === "initializing" ? <div className={styles.status}>{t("読み込み中…")}</div> : null}
      {/* Non-numeric DOM alternative for the canvas (DESIGN.md §9): a
          short state line — direction/state words, never numbers — that
          updates only on meaningful changes. role=status announces it. */}
      {statusHidden !== true && (
        <Status
          text={describeCreature(visualState, presentation, lang)}
          className={styles.creatureStatus}
          testId="creature-status"
        />
      )}
    </section>
  );
}
