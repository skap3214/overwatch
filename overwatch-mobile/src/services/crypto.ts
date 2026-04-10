/**
 * E2E encryption for relay mode.
 * Uses nacl.box (X25519 + XSalsa20-Poly1305) via tweetnacl.
 * Same construction as the CLI side.
 */

// Must be imported before tweetnacl — polyfills crypto.getRandomValues for Hermes
import "react-native-get-random-values";
import nacl from "tweetnacl";

export type KeyPair = {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
};

export function generateKeyPair(): KeyPair {
  return nacl.box.keyPair();
}

export function deriveSharedKey(
  theirPublicKey: Uint8Array,
  ourSecretKey: Uint8Array
): Uint8Array {
  return nacl.box.before(theirPublicKey, ourSecretKey);
}

export function encrypt(
  message: string | Uint8Array,
  sharedKey: Uint8Array
): Uint8Array {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const messageBytes =
    typeof message === "string" ? new TextEncoder().encode(message) : message;
  const encrypted = nacl.box.after(messageBytes, nonce, sharedKey);
  if (!encrypted) throw new Error("Encryption failed");
  const frame = new Uint8Array(nonce.length + encrypted.length);
  frame.set(nonce, 0);
  frame.set(encrypted, nonce.length);
  return frame;
}

export function decryptToString(
  frame: Uint8Array,
  sharedKey: Uint8Array
): string {
  const nonce = frame.slice(0, nacl.box.nonceLength);
  const ciphertext = frame.slice(nacl.box.nonceLength);
  const decrypted = nacl.box.open.after(ciphertext, nonce, sharedKey);
  if (!decrypted) throw new Error("Decryption failed");
  return new TextDecoder().decode(decrypted);
}

export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
