import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AcceptedMessage } from "@yuragoo/ai";
import type { CreaturePresentation, CreatureRuntime } from "@yuragoo/creature";
import { type ChoiceId, parseChoiceId } from "@yuragoo/protocol";
import { CreatureStage } from "../game/CreatureStage";
import { installDecisionBridge } from "./decision-bridge";
import {
  acceptMessage,
  anticipationSamples,
  buildNextState,
  DEFAULT_CHOICE,
  type FlowSnap,
  INITIAL_SNAP,
  LAB_CHOICES,
  LAB_PERSONA,
  LAB_SCENARIO,
  restSamples,
  STATUS_LABELS,
} from "./decision-flow";
import {
  createLiveEvaluate,
  createMockEvaluate,
  createSessionId,
  type LabSource,
} from "./decision-providers";
import { runStagedEvaluation } from "./decision-staging";
import styles from "./DecisionLab.module.css";

const PROVIDERS: readonly { id: LabSource; label: string }[] = [
  { id: "mock", label: "モック" },
  { id: "live", label: "ライブ" },
];

const REST_PRESENTATION: CreaturePresentation = {
  samples: restSamples(),
  expression: "rest",
  reducedMotion: false,
};

export default function DecisionLab() {
  const [provider, setProvider] = useState<LabSource>("mock");
  const [advocated, setAdvocated] = useState<ChoiceId>(DEFAULT_CHOICE);
  const [text, setText] = useState("");
  const [gatewayUrl, setGatewayUrl] = useState("http://127.0.0.1:8787");
  const [pose, setPose] = useState<CreaturePresentation>(REST_PRESENTATION);
  const [snap, setSnap] = useState<FlowSnap>(INITIAL_SNAP);
  const [resultLine, setResultLine] = useState("—");
  const [log, setLog] = useState<readonly { seq: number; text: string }[]>([]);
  const [sessionId] = useState(createSessionId);

  const runtimeRef = useRef<CreatureRuntime | null>(null);
  const snapRef = useRef(snap);
  const messagesRef = useRef<AcceptedMessage[]>([]);
  const inputSeqRef = useRef(0);
  const submitSeqRef = useRef(0);
  const mockDelayRef = useRef(0);
  const failNextRef = useRef<string | null>(null);
  const scenarioKeyRef = useRef<string | undefined>(undefined);
  const providerRef = useRef(provider);
  const gatewayUrlRef = useRef(gatewayUrl);
  providerRef.current = provider;
  gatewayUrlRef.current = gatewayUrl;

  const mockEvaluate = useMemo(createMockEvaluate, []);
  // snapRef mirrors the last snapshot synchronously so the e2e bridge can read
  // mid-flight state even before React commits the render.
  const patchSnap = useCallback((patch: Partial<FlowSnap>): void => {
    const next = { ...snapRef.current, ...patch };
    snapRef.current = next;
    setSnap(next);
  }, []);

  const submit = useCallback(
    async (rawText: string, choiceId: ChoiceId): Promise<void> => {
      const trimmed = rawText.trim();
      if (trimmed.length === 0) return;
      const t0 = performance.now();
      // Staged reaction: the creature leans toward the advocated choice
      // synchronously, long before the decision resolves.
      setPose({
        samples: anticipationSamples(choiceId),
        expression: "hesitating",
        reducedMotion: false,
      });
      const anticipationMs = performance.now() - t0;
      submitSeqRef.current += 1;
      inputSeqRef.current += 1;
      const seq = submitSeqRef.current;
      const inputSeq = inputSeqRef.current;
      messagesRef.current = [...messagesRef.current, acceptMessage(inputSeq, trimmed, choiceId)];
      setLog((prev) => [...prev, { seq: inputSeq, text: trimmed }].slice(-12));
      const useMock = providerRef.current === "mock";
      const built = buildNextState(
        inputSeq,
        messagesRef.current,
        choiceId,
        useMock,
        scenarioKeyRef.current,
      );
      patchSnap({
        status: "pending",
        anticipationMs,
        anticipationAt: anticipationMs,
        conflictedAt: 0,
        resolvedAt: 0,
        revision: inputSeq,
        contextSize: built.contextSize,
        errorKind: null,
      });
      const evaluate = useMock
        ? mockEvaluate
        : createLiveEvaluate(gatewayUrlRef.current, sessionId);
      await runStagedEvaluation(
        {
          show: (samples, expression) => setPose({ samples, expression, reducedMotion: false }),
          express: (expression) => setPose((prev) => ({ ...prev, expression })),
          patch: patchSnap,
          result: setResultLine,
          isStale: () => seq !== submitSeqRef.current,
          failNext: () => {
            const kind = failNextRef.current;
            failNextRef.current = null;
            return kind;
          },
          mockDelayMs: () => (useMock ? mockDelayRef.current : 0),
        },
        evaluate,
        built.state,
        t0,
      );
    },
    [mockEvaluate, patchSnap, sessionId],
  );

  useEffect(
    () =>
      installDecisionBridge({
        submit: (nextText, choiceId) => submit(nextText, parseChoiceId(choiceId)),
        state: () => ({ ...snapRef.current, provider: providerRef.current }),
        pose: () => {
          const runtime = runtimeRef.current;
          if (!runtime) throw new Error("runtime not ready");
          return runtime.readPoseSummary();
        },
        controls: {
          mockDelay: mockDelayRef,
          failNext: failNextRef,
          scenarioKey: scenarioKeyRef,
        },
      }),
    [submit],
  );

  return (
    <main className={styles.page}>
      <h1>けっていラボ</h1>
      <p className={styles.meta}>
        {LAB_SCENARIO} — {LAB_PERSONA}
      </p>
      <div className={styles.stageWrap}>
        <CreatureStage
          visualState="normal"
          presentation={pose}
          onReady={(runtime) => {
            runtimeRef.current = runtime;
          }}
        />
      </div>
      <section className={styles.group} aria-label="評価プロバイダー">
        {PROVIDERS.map((p) => (
          <button
            key={p.id}
            type="button"
            data-testid={`provider-${p.id}`}
            aria-pressed={provider === p.id}
            onClick={() => setProvider(p.id)}
          >
            {p.label}
          </button>
        ))}
        <span className={styles.badge} data-testid="provider-badge">
          {provider === "mock" ? "mock" : "live gateway"}
        </span>
      </section>
      {provider === "live" ? (
        <label className={styles.field}>
          ゲートウェイURL
          <input
            type="url"
            data-testid="gateway-url"
            value={gatewayUrl}
            onChange={(event) => setGatewayUrl(event.target.value)}
          />
        </label>
      ) : null}
      <section className={styles.group} aria-label="推す選択肢">
        {LAB_CHOICES.map((choice) => (
          <button
            key={choice.id}
            type="button"
            data-testid={`advocate-${choice.id}`}
            aria-pressed={advocated === choice.id}
            onClick={() => setAdvocated(choice.id)}
          >
            {choice.symbol} {choice.label}
          </button>
        ))}
      </section>
      <form
        className={styles.post}
        onSubmit={(event) => {
          event.preventDefault();
          void submit(text, advocated);
        }}
      >
        <label className={styles.field}>
          自由投稿（日本語OK）
          <input
            type="text"
            data-testid="post-text"
            maxLength={120}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <button type="submit" data-testid="post-submit" disabled={snap.status === "pending"}>
          投稿
        </button>
      </form>
      <p className={styles.status} data-testid="flow-status" data-status={snap.status}>
        status: {STATUS_LABELS[snap.status]}
      </p>
      <p className={styles.status} data-testid="last-result">
        {resultLine}
      </p>
      {snap.errorKind !== null ? (
        <p role="alert" className={styles.error}>
          評価に失敗しました: {snap.errorKind}
        </p>
      ) : null}
      <ul className={styles.log} data-testid="context-log">
        {log.map((entry) => (
          <li key={entry.seq}>{entry.text}</li>
        ))}
      </ul>
    </main>
  );
}
