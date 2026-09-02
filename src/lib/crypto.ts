/**
 * Client-side End-to-End Encryption using Web Crypto API (AES-GCM-256)
 * 
 * Guarantees Zero-Knowledge privacy:
 * - Keys are generated in browser memory and placed only in the URL hash fragment (#key=...)
 * - URL hash fragments are never sent over HTTP to the server
 * - Payloads are encrypted client-side before upload and decrypted client-side after download
 */

export interface EncryptedPayloadBundle {
  ciphertext: string; // Base64 encoded encrypted bytes
  iv: string;         // Base64 encoded 12-byte initialization vector
  isEncrypted: boolean;
}

// Convert ArrayBuffer to Base64 string
function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

// Convert Base64 string to ArrayBuffer
function base64ToBuffer(base64: string): ArrayBuffer {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// Convert ArrayBuffer to Base64URL string (safe for URL hash)
function bufferToBase64Url(buffer: ArrayBuffer): string {
  return bufferToBase64(buffer)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// Convert Base64URL string back to ArrayBuffer
function base64UrlToBuffer(base64Url: string): ArrayBuffer {
  let base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  return base64ToBuffer(base64);
}

/**
 * Generates a random 256-bit AES-GCM encryption key
 */
export async function generateE2EKey(): Promise<CryptoKey> {
  return window.crypto.subtle.generateKey(
    {
      name: 'AES-GCM',
      length: 256,
    },
    true,
    ['encrypt', 'decrypt']
  );
}

/**
 * Export CryptoKey to Base64URL string for URL hash storage
 */
export async function exportKeyToString(key: CryptoKey): Promise<string> {
  const rawKey = await window.crypto.subtle.exportKey('raw', key);
  return bufferToBase64Url(rawKey);
}

/**
 * Import CryptoKey from Base64URL string
 */
export async function importKeyFromString(keyString: string): Promise<CryptoKey> {
  const rawKey = base64UrlToBuffer(keyString);
  return window.crypto.subtle.importKey(
    'raw',
    rawKey,
    {
      name: 'AES-GCM',
    },
    false,
    ['decrypt']
  );
}

/**
 * Encrypt a text or binary data string with AES-GCM-256
 */
export async function encryptData(
  data: string,
  key: CryptoKey
): Promise<EncryptedPayloadBundle> {
  const encoder = new TextEncoder();
  const encodedData = encoder.encode(data);

  // 12-byte IV standard for AES-GCM
  const iv = window.crypto.getRandomValues(new Uint8Array(12));

  const encryptedBuffer = await window.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv,
    },
    key,
    encodedData
  );

  return {
    ciphertext: bufferToBase64(encryptedBuffer),
    iv: bufferToBase64(iv.buffer),
    isEncrypted: true,
  };
}

/**
 * Decrypt ciphertext bundle using AES-GCM-256
 */
export async function decryptData(
  encryptedBundle: EncryptedPayloadBundle,
  key: CryptoKey
): Promise<string> {
  const ciphertextBuffer = base64ToBuffer(encryptedBundle.ciphertext);
  const ivBuffer = base64ToBuffer(encryptedBundle.iv);

  const decryptedBuffer = await window.crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: new Uint8Array(ivBuffer),
    },
    key,
    ciphertextBuffer
  );

  const decoder = new TextDecoder();
  return decoder.decode(decryptedBuffer);
}

/**
 * Sanitize filename to prevent directory traversal and script injection attacks
 */
export function sanitizeFilename(filename: string): string {
  if (!filename) return 'unnamed-file';
  // Strip control characters, path traversals, and normalize
  const sanitized = filename
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/[/\\]/g, '_')
    .replace(/\.\./g, '_')
    .trim();

  return sanitized.length > 0 ? sanitized : 'sanitized-file';
}
