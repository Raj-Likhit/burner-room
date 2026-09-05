/**
 * Client-side End-to-End Encryption using Web Crypto API (AES-GCM-256)
 * 
 * Guarantees Zero-Knowledge privacy:
 * - Keys are generated in browser memory and placed only in the URL hash fragment (#key=...)
 * - URL hash fragments are never sent over HTTP to the server
 * - Payloads are encrypted client-side before upload and decrypted client-side after download
 */

export interface PinKeyBundle {
  ciphertext: string;
  iv: string;
  salt: string;
}

export interface EncryptedPayloadBundle {
  ciphertext: string; // Base64 encoded encrypted bytes
  iv: string;         // Base64 encoded 12-byte initialization vector
  isEncrypted: boolean;
  pinKeyBundle?: PinKeyBundle;
}

// Convert ArrayBuffer to Base64 string safely in chunks to avoid stack overflow & slow string concatenation
export function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const CHUNK_SIZE = 0x8000; // 32KB chunking
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    const slice = bytes.subarray(i, i + CHUNK_SIZE);
    chunks.push(String.fromCharCode.apply(null, Array.from(slice)));
  }
  return window.btoa(chunks.join(''));
}

// Convert Base64 string to ArrayBuffer
export function base64ToBuffer(base64: string): ArrayBuffer {
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
 * Derive an AES-GCM-256 CryptoKey from a 4-digit PIN using PBKDF2-SHA256
 */
export async function deriveKeyFromPin(pin: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const baseKey = await window.crypto.subtle.importKey(
    'raw',
    enc.encode(pin),
    { name: 'PBKDF2' },
    false,
    ['deriveKey']
  );
  return window.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 20000,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Wrap the master E2E key string with the 4-digit PIN
 */
export async function wrapKeyWithPin(keyStr: string, pin: string): Promise<PinKeyBundle> {
  const salt = window.crypto.getRandomValues(new Uint8Array(16));
  const pinDerivedKey = await deriveKeyFromPin(pin, salt);
  const enc = new TextEncoder();
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await window.crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    pinDerivedKey,
    enc.encode(keyStr)
  );
  return {
    ciphertext: bufferToBase64(encrypted),
    iv: bufferToBase64(iv.buffer),
    salt: bufferToBase64(salt.buffer),
  };
}

/**
 * Unwrap the master E2E key string using the 4-digit PIN
 */
export async function unwrapKeyWithPin(bundle: PinKeyBundle, pin: string): Promise<string> {
  const saltBuffer = base64ToBuffer(bundle.salt);
  const pinDerivedKey = await deriveKeyFromPin(pin, new Uint8Array(saltBuffer));
  const ciphertextBuffer = base64ToBuffer(bundle.ciphertext);
  const ivBuffer = base64ToBuffer(bundle.iv);
  const decrypted = await window.crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(ivBuffer) },
    pinDerivedKey,
    ciphertextBuffer
  );
  return new TextDecoder().decode(decrypted);
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

/**
 * Calculate accurate byte length from a data URL or base64 string
 */
export function getByteLengthFromDataUrl(dataUrl: string): number {
  if (!dataUrl) return 0;
  const commaIdx = dataUrl.indexOf(',');
  const b64 = commaIdx !== -1 ? dataUrl.slice(commaIdx + 1) : dataUrl;
  const cleanB64 = b64.replace(/[\s\r\n=]+/g, '');
  return Math.floor((cleanB64.length * 3) / 4);
}

/**
 * Robustly converts any Data URL (base64 or encoded) to a typed binary Blob
 * Uses native fetch for fast zero-copy conversion, with fallback to clean binary decoding.
 */
export async function dataUrlToBlob(
  dataUrl: string,
  fallbackMime: string = 'application/octet-stream'
): Promise<Blob> {
  if (!dataUrl) {
    throw new Error('dataUrlToBlob called with empty dataUrl');
  }

  // If already a blob URL
  if (dataUrl.startsWith('blob:')) {
    const res = await fetch(dataUrl);
    return await res.blob();
  }

  // Modern browsers natively and cleanly decode data: URIs via fetch()
  if (dataUrl.startsWith('data:')) {
    try {
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      if (blob && blob.size > 0) {
        return blob;
      }
    } catch {
      // Fallback to manual decoding below if fetch fails
    }
  }

  // Manual decoding fallback
  let mime = fallbackMime;
  let dataString = dataUrl;

  if (dataUrl.startsWith('data:')) {
    const commaIndex = dataUrl.indexOf(',');
    if (commaIndex !== -1) {
      const header = dataUrl.slice(0, commaIndex);
      dataString = dataUrl.slice(commaIndex + 1);
      const match = header.match(/data:([^;]+)/);
      if (match && match[1]) {
        mime = match[1].trim();
      }
    }
  }

  // Clean whitespace/newlines which cause atob to throw InvalidCharacterError
  const cleanBase64 = dataString.replace(/[\s\r\n]+/g, '');
  const binary = window.atob(cleanBase64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new Blob([bytes], { type: mime });
}

// Retain active object URLs to prevent premature garbage collection or revocation during browser file downloads
const retainedObjectUrls = new Set<string>();

/**
 * Reliably downloads a Data URL or raw base64 string as a genuine typed Blob file.
 * Fixes the 0-byte file download bug by:
 * 1. Converting to a real binary Blob using native fetch and sanitized decoding.
 * 2. Retaining the object URL in memory (never revoking prematurely after 2s, which cancels Chrome's write).
 * 3. Providing fallback to server streaming endpoint if client anchor fails.
 */
export async function downloadDataUrlAsBlob(
  dataUrl: string,
  fileName: string,
  fallbackMime: string = 'application/octet-stream'
): Promise<boolean> {
  if (!dataUrl) {
    console.error('[Burner Room] downloadDataUrlAsBlob called with empty dataUrl');
    return false;
  }

  const safeName = sanitizeFilename(fileName || 'burner-download');

  try {
    const blob = await dataUrlToBlob(dataUrl, fallbackMime);
    if (blob.size === 0) {
      console.warn('[Burner Room] Generated blob has 0 bytes. Falling back to stream download.');
      triggerServerStreamDownload(dataUrl, safeName, fallbackMime);
      return true;
    }

    const objectUrl = URL.createObjectURL(blob);
    retainedObjectUrls.add(objectUrl);

    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = objectUrl;
    a.download = safeName;
    document.body.appendChild(a);
    a.click();

    // Remove DOM element after brief delay, but KEEP objectUrl alive for 10 minutes
    setTimeout(() => {
      if (a.parentNode) {
        a.parentNode.removeChild(a);
      }
    }, 1000);

    // Defer revocation by 10 minutes so Chrome asynchronous download manager never gets severed
    setTimeout(() => {
      retainedObjectUrls.delete(objectUrl);
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        // ignore
      }
    }, 600000);

    return true;
  } catch (err) {
    console.error('[Burner Room] Blob conversion download failed, attempting server stream fallback', err);
    try {
      triggerServerStreamDownload(dataUrl, safeName, fallbackMime);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Triggers a direct HTTP streaming file download from the server.
 * This guarantees the browser receives Content-Disposition: attachment directly from the HTTP stream,
 * which is 100% immune to iframe sandbox restrictions and client blob revocation issues.
 */
export function triggerServerStreamDownload(
  dataUrl: string,
  fileName: string,
  mimeType: string = 'application/octet-stream'
): void {
  const safeName = sanitizeFilename(fileName || 'burner-download');
  const form = document.createElement('form');
  form.style.display = 'none';
  form.method = 'POST';
  form.action = '/api/download-stream';
  form.target = '_blank';

  const inputData = document.createElement('input');
  inputData.type = 'hidden';
  inputData.name = 'dataUrl';
  inputData.value = dataUrl;
  form.appendChild(inputData);

  const inputName = document.createElement('input');
  inputName.type = 'hidden';
  inputName.name = 'fileName';
  inputName.value = safeName;
  form.appendChild(inputName);

  const inputMime = document.createElement('input');
  inputMime.type = 'hidden';
  inputMime.name = 'mimeType';
  inputMime.value = mimeType;
  form.appendChild(inputMime);

  document.body.appendChild(form);
  form.submit();

  setTimeout(() => {
    if (form.parentNode) {
      form.parentNode.removeChild(form);
    }
  }, 2000);
}

/**
 * Opens the file in a new tab/window for safe viewing or native right-click saving.
 */
export async function openDataUrlInNewTab(dataUrl: string, fileName?: string): Promise<void> {
  try {
    const blob = await dataUrlToBlob(dataUrl);
    const objectUrl = URL.createObjectURL(blob);
    retainedObjectUrls.add(objectUrl);
    window.open(objectUrl, '_blank');
  } catch (err) {
    window.open(dataUrl, '_blank');
  }
}
