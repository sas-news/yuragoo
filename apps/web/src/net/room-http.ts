// Room-auth HTTP calls (Task 20/24): reconnect-token rotation and the
// session-to-ticket exchange, split out of reconnect.ts for the size cap.
// Raw tokens cross the wire only in these request bodies — the server
// stores hashes.
export interface RoomCredentials {
  readonly playerId: string;
  readonly sessionToken: string;
  readonly reconnectToken: string;
}

export class RoomAuthError extends Error {
  // Auth-route failure carrying the HTTP status for terminal detection.
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(`${code} (${status})`);
    this.name = "RoomAuthError";
  }
}

const postJson = async (origin: string, path: string, body: unknown): Promise<Response> =>
  fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const errorOf = async (res: Response): Promise<RoomAuthError> => {
  let code = `http-${res.status}`;
  try {
    const body: unknown = await res.json();
    if (body !== null && typeof body === "object" && "error" in body) {
      const c = (body as { error: unknown }).error;
      if (typeof c === "string") code = c;
    }
  } catch {
    // Non-JSON body: keep the status-derived code.
  }
  return new RoomAuthError(code, res.status);
};

// Reconnect token -> rotated {session,reconnect} pair; the old pair dies
// server-side the moment the new hashes land.
export const rotateCredentials = async (
  origin: string,
  roomId: string,
  reconnectToken: string,
): Promise<RoomCredentials> => {
  const res = await postJson(origin, `/api/rooms/${roomId}/reconnect`, { reconnectToken });
  if (!res.ok) throw await errorOf(res);
  return (await res.json()) as RoomCredentials;
};

export const issueTicket = async (
  origin: string,
  roomId: string,
  sessionToken: string,
): Promise<string> => {
  const res = await postJson(origin, `/api/rooms/${roomId}/ticket`, { sessionToken });
  if (!res.ok) throw await errorOf(res);
  const body = (await res.json()) as { ticket: string };
  return body.ticket;
};
