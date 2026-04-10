/**
 * E2E encryption for the Overwatch relay.
 *
 * Uses nacl.box (X25519 + XSalsa20-Poly1305) via tweetnacl.
 * Both CLI and mobile app import this module.
 *
 * Wire format per encrypted frame:
 *   [24 bytes: nonce] [N bytes: ciphertext + 16-byte Poly1305 auth tag]
 */

import nacl from "tweetnacl";

export type KeyPair = {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
};

/**
 * Generate an ephemeral X25519 key pair.
 */
export function generateKeyPair(): KeyPair {
  return nacl.box.keyPair();
}

/**
 * Derive a shared key from our secret key and their public key.
 * This is the precomputed shared secret for nacl.box.
 */
export function deriveSharedKey(
  theirPublicKey: Uint8Array,
  ourSecretKey: Uint8Array
): Uint8Array {
  return nacl.box.before(theirPublicKey, ourSecretKey);
}

/**
 * Encrypt a message (UTF-8 string or raw bytes) using a precomputed shared key.
 * Returns a binary frame: [24-byte nonce][ciphertext+tag]
 */
export function encrypt(
  message: string | Uint8Array,
  sharedKey: Uint8Array
): Uint8Array {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const messageBytes =
    typeof message === "string" ? new TextEncoder().encode(message) : message;
  const encrypted = nacl.box.after(messageBytes, nonce, sharedKey);
  if (!encrypted) {
    throw new Error("Encryption failed");
  }
  // Combine nonce + ciphertext into a single frame
  const frame = new Uint8Array(nonce.length + encrypted.length);
  frame.set(nonce, 0);
  frame.set(encrypted, nonce.length);
  return frame;
}

/**
 * Decrypt a binary frame: [24-byte nonce][ciphertext+tag]
 * Returns the plaintext as a UTF-8 string.
 */
export function decryptToString(
  frame: Uint8Array,
  sharedKey: Uint8Array
): string {
  const bytes = decryptToBytes(frame, sharedKey);
  return new TextDecoder().decode(bytes);
}

/**
 * Decrypt a binary frame: [24-byte nonce][ciphertext+tag]
 * Returns the plaintext as raw bytes.
 */
export function decryptToBytes(
  frame: Uint8Array,
  sharedKey: Uint8Array
): Uint8Array {
  if (frame.length < nacl.box.nonceLength + nacl.box.overheadLength) {
    throw new Error("Frame too short to contain a valid encrypted message");
  }
  const nonce = frame.slice(0, nacl.box.nonceLength);
  const ciphertext = frame.slice(nacl.box.nonceLength);
  const decrypted = nacl.box.open.after(ciphertext, nonce, sharedKey);
  if (!decrypted) {
    throw new Error("Decryption failed — invalid key or corrupted message");
  }
  return decrypted;
}

/**
 * Encode a Uint8Array as base64 string (for QR code / JSON transport).
 */
export function toBase64(bytes: Uint8Array): string {
  // Works in both Node.js and React Native
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Decode a base64 string to Uint8Array.
 */
export function fromBase64(base64: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(base64, "base64"));
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
