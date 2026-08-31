import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { requireEnv } from "./env";

function key(): Buffer {
  const raw = Buffer.from(requireEnv("CREDENTIAL_KEY"), "base64");
  if (raw.length !== 32) {
    throw new Error("CREDENTIAL_KEY must be 32 bytes, base64-encoded");
  }
  return raw;
}

export interface Sealed {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

export function seal(plaintext: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

export function open(sealed: Sealed): string {
  const decipher = createDecipheriv("aes-256-gcm", key(), sealed.iv);
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]).toString("utf8");
}

/** Fails fast at boot on a missing/malformed CREDENTIAL_KEY, rather than on the first save. */
export function assertCredentialKeyConfigured(): void {
  key();
}
