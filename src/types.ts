export type PayloadType = 'text' | 'file';
export type ShareMode = 'burn_on_read' | 'multiple_reads';

export interface BurnerFileMetadata {
  name: string;
  size: number;
  type: string;
  lastModified?: number;
  /**
   * For Vercel Blob storage, stores the secure download URL.
   * For local/in-memory, stores base64 data URL or buffer ref.
   */
  blobUrl?: string;
  dataUrl?: string;
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
  /** Text content if type is 'text' */
  textContent?: string;
  /** File metadata and binary/blob pointer if type is 'file' */
  file?: BurnerFileMetadata;
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
  createdAt: number;
  expiresAt: number;
  ttlSeconds: number;
}

export interface DropPayloadRequest {
  pin: string;
  type: PayloadType;
  shareMode?: ShareMode;
  ttlSeconds?: number;
  textContent?: string;
  file?: BurnerFileMetadata;
}

export interface PickupPayloadResponse {
  success: boolean;
  message?: string;
  isBurned?: boolean;
  readCount?: number;
  shareMode?: ShareMode;
  payload?: BurnerPayload;
}
