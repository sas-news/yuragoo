// Shared fixtures for the AI gateway worker tests. The API key here is a
// placeholder only — never a real secret and never printed.
export const STATE = {
  revision: 1,
  scenario: "雨の日の散歩",
  persona: "穏やかな観察者",
  activeContext: [],
  choices: [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ],
};

export const WIRE_OK = {
  model: "jev-1.13.0",
  answers: {
    attraction: {
      type: "choice",
      choice: "a",
      confidence: 0.8,
      probabilities: { a: 0.7, b: 0.3 },
    },
  },
  usage: { input_tokens: 11, output_tokens: 9 },
};

export const BINDINGS = {
  APP_ENV: "local",
  JEV_API_KEY: "test-placeholder-key",
  JEV_DAILY_ATTEMPT_CAP: "1000",
};

export const SESSION = "session-0001";

export interface SendRecord {
  readonly url: string;
  readonly authorization: string | null;
  readonly hasAuthHeader: boolean;
}

export const countingFetch = (
  sent: SendRecord[],
  responder: (call: number) => Response | Promise<Response>,
): typeof fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    sent.push({
      url: String(input),
      authorization: headers.get("authorization"),
      hasAuthHeader: headers.has("authorization"),
    });
    return responder(sent.length);
  }) as typeof fetch;

export const okResponse = (): Response =>
  new Response(JSON.stringify(WIRE_OK), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

export const statusResponse = (status: number, retryAfter?: string): Response =>
  new Response("{}", {
    status,
    headers: retryAfter === undefined ? {} : { "retry-after": retryAfter },
  });

// Never resolves on its own; rejects when the combined abort signal fires.
export const hangingFetch = (sent: SendRecord[]): typeof fetch =>
  ((input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), authorization: null, hasAuthHeader: false });
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  }) as typeof fetch;

interface Fetchable {
  fetch(request: Request): Promise<Response> | Response;
}

export const post = (app: Fetchable, host = "localhost", body?: unknown): Promise<Response> =>
  Promise.resolve(
    app.fetch(
      new Request(`http://${host}/api/dev/jev/evaluate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? { sessionId: SESSION, state: STATE }),
      }),
    ),
  );
