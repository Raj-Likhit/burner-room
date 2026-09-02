export type PayloadType = 'text' | 'file';
export type ShareMode = 'burn_on_read' | 'multiple_reads';

export interface ApiErrorDetail {
  code: string;
  message: string;
  retryable?: boolean;
  retryAfter?: number;
}

export interface ApiErrorResponse {
  error: ApiErrorDetail;
}

export interface BurnerFileMetadata {
  name: string;
  size: number;
  type: string;
  lastModified?: number;
  dataUrl?: string; // May be encrypted or unencrypted data URL
}

export interface EncryptedBundle {
  ciphertext: string;
  iv: string;
  isEncrypted: boolean;
}

export interface BurnerPayload {
  /** 4-digit numeric session PIN (e.g., "4921") */
  pin: string;
  /** Payload classification: raw text or uploaded file */
  type: PayloadType;
  /** Share policy: single-read self-destruct or multiple-device access */
  shareMode: ShareMode;
  /** How many times this payload has been retrieved */
  readCount: number;
  /** Max allowed reads for multi-share before auto-incineration (optional) */
  maxReads?: number;
  /** Text content if type is 'text' */
  textContent?: string;
  /** File metadata and binary/blob pointer if type is 'file' */
  file?: BurnerFileMetadata;
  /** End-to-end encrypted bundle if E2E enabled */
  encryptedBundle?: EncryptedBundle;
  /** Timestamp (ms) when the payload was dropped */
  createdAt: number;
  /** Timestamp (ms) when the payload automatically self-destructs */
  expiresAt: number;
  /** Time-to-live duration in seconds (defaults to 600s = 10 mins) */
  ttlSeconds: number;
  /** Status tracking */
  status: 'pending' | 'retrieved' | 'expired';
}

export interface SessionResponse {
  pin: string;
  senderToken: string;
  createdAt: number;
  expiresAt: number;
  ttlSeconds: number;
}

export interface CheckPinAvailabilityResponse {
  available: boolean;
  pin: string;
  message?: string;
}

export interface DropPayloadRequest {
  pin: string;
  senderToken?: string;
  type: PayloadType;
  shareMode?: ShareMode;
  maxReads?: number;
  ttlSeconds?: number;
  textContent?: string;
  file?: BurnerFileMetadata;
  encryptedBundle?: EncryptedBundle;
}

export interface DropPayloadResponse {
  success: boolean;
  message?: string;
  pin?: string;
  senderToken?: string;
  shareMode?: ShareMode;
  maxReads?: number;
  expiresAt?: number;
  ttlSeconds?: number;
  error?: ApiErrorDetail;
}

export interface PickupPayloadResponse {
  success: boolean;
  message?: string;
  error?: ApiErrorDetail;
  isBurned?: boolean;
  readCount?: number;
  maxReads?: number;
  shareMode?: ShareMode;
  payload?: BurnerPayload;
}

export interface CheckPayloadResponse {
  exists: boolean;
  type?: PayloadType;
  shareMode?: ShareMode;
  readCount?: number;
  maxReads?: number;
  expiresAt?: number;
  remainingSeconds?: number;
  fileMeta?: {
    name: string;
    size: number;
    type: string;
  };
  isEncrypted?: boolean;
  error?: ApiErrorDetail;
}

export interface StoredSenderSession {
  pin: string;
  senderToken: string;
  expiresAt: number;
  ttlSeconds: number;
  isUploaded: boolean;
  uploadedType?: PayloadType;
  uploadedFileName?: string;
  uploadedFileSize?: number;
  uploadedTextPreview?: string;
  shareMode: ShareMode;
  maxReads?: number;
  e2eKeyString?: string;
}
