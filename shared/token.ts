// Per-call credentials. The dynamic-variables webhook signs a small claims object (who called,
// which booking they're verified for, which trace) and encrypts it for Telnyx's
// encrypted_dynamic_variables. Telnyx decrypts it and sends it to the MCP server as the bearer,
// so the MCP server knows the call and the booking without trusting anything the model says.
import { createCipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { CallClaims } from "./types";

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function signClaims(claims: CallClaims, signingKey: string): string {
  const body = b64u(JSON.stringify(claims));
  const sig = createHmac("sha256", signingKey).update(body).digest("base64url");
  return `v1.${body}.${sig}`;
}

export function verifyClaims(token: string, signingKey: string): CallClaims | null {
  const [v, body, sig] = token.split(".");
  if (v !== "v1" || !body || !sig) return null;
  const want = createHmac("sha256", signingKey).update(body).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  const claims = JSON.parse(Buffer.from(body, "base64url").toString()) as CallClaims;
  return claims.exp > Date.now() ? claims : null;
}

/** AES-256-GCM, base64url(nonce || ciphertext || tag): the scheme Telnyx decrypts. */
export function encryptForTelnyx(plaintext: string, keyB64u: string): string {
  const key = Buffer.from(keyB64u, "base64url");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([nonce, ct]).toString("base64url");
}
