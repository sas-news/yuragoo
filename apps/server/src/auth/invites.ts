// Opaque secret primitives for the room-auth API. Secrets are 256-bit
// CSPRNG output base64url-encoded; the server only ever persists their
// SHA-256 hashes, so verification is a hash-to-hash equality check and a
// leaked database row can never replay a token.
const encoder = new TextEncoder();

// base64url without padding — safe in URL fragments, query values and the
// game-core playerId alphabet ([A-Za-z0-9_-]).
export const base64url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

export const randomToken = (byteLength: number): string =>
  base64url(crypto.getRandomValues(new Uint8Array(byteLength)));

export const sha256B64 = async (text: string): Promise<string> =>
  base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));

// The browser invite secret: 256 bits, exchanged once via the URL fragment
// + join POST body, stored as a hash for the room's whole lifetime.
export const newInviteSecret = (): string => randomToken(32);
