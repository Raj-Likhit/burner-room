import {
  ApiErrorDetail,
  CheckPayloadResponse,
  DropPayloadRequest,
  DropPayloadResponse,
  PickupPayloadResponse,
  SessionResponse,
  CheckPinAvailabilityResponse,
} from '../types';

export class BurnerApiError extends Error {
  public code: string;
  public retryable: boolean;
  public retryAfter?: number;
  public status: number;
  public bootId?: string;

  constructor(detail: ApiErrorDetail, status: number = 400, bootId?: string) {
    super(detail.message);
    this.name = 'BurnerApiError';
    this.code = detail.code;
    this.retryable = detail.retryable ?? false;
    this.retryAfter = detail.retryAfter;
    this.status = status;
    this.bootId = bootId;
  }
}

// Track server boot ID to detect server restarts
let activeServerBootId: string | null = null;
export function getServerBootId(): string | null {
  return activeServerBootId;
}
export function setServerBootId(id: string | null) {
  activeServerBootId = id;
}

/**
 * Standardized client-side error normalizer
 */
export function normalizeApiError(errorObj: any, status: number = 0, bootId?: string): ApiErrorDetail {
  if (errorObj?.error && typeof errorObj.error === 'object' && errorObj.error.code) {
    return {
      code: errorObj.error.code,
      message: errorObj.error.message || 'An unexpected error occurred.',
      retryable: errorObj.error.retryable ?? (status >= 500 || status === 429 || status === 409),
      retryAfter: errorObj.error.retryAfter,
    };
  }

  // Handle fallback string errors from server
  if (typeof errorObj?.error === 'string') {
    return {
      code: errorObj.errorCode || (status === 429 ? 'RATE_LIMITED' : status === 409 ? 'SLOTS_BUSY' : 'API_ERROR'),
      message: errorObj.error,
      retryable: status >= 500 || status === 429 || status === 409,
      retryAfter: errorObj.retryAfter,
    };
  }

  if (typeof errorObj?.message === 'string') {
    return {
      code: errorObj.code || 'API_ERROR',
      message: errorObj.message,
      retryable: status >= 500 || status === 409,
    };
  }

  // Fallback based on HTTP status
  if (status === 404) {
    return {
      code: 'PIN_NOT_FOUND',
      message: 'No active payload found for this PIN. It may have never existed, was already purged, or the server restarted.',
      retryable: false,
    };
  }
  if (status === 409) {
    return {
      code: 'SLOTS_BUSY',
      message: 'All download slots are currently occupied. Another recipient is downloading. Please retry shortly.',
      retryable: true,
      retryAfter: 3,
    };
  }
  if (status === 410) {
    return {
      code: 'FILE_DELETED',
      message: 'File has been deleted.',
      retryable: false,
    };
  }
  if (status === 413) {
    return {
      code: 'PAYLOAD_TOO_LARGE',
      message: 'File exceeds the maximum 50MB RAM buffer ceiling.',
      retryable: false,
    };
  }
  if (status === 429) {
    return {
      code: 'LOCKED_OUT',
      message: 'Too many attempts. Access is temporarily locked.',
      retryable: true,
      retryAfter: 600,
    };
  }
  if (status === 503) {
    return {
      code: errorObj?.error?.code || 'SERVER_UNAVAILABLE',
      message: errorObj?.error?.message || 'Server is temporarily unavailable. Please connect directly to the primary server instance.',
      retryable: false,
    };
  }
  if (status === 507) {
    return {
      code: 'BUFFER_FULL',
      message: 'Ephemeral RAM buffer is currently full. Active drops are cycling—please try again shortly.',
      retryable: true,
      retryAfter: 15,
    };
  }

  return {
    code: 'UNKNOWN_ERROR',
    message: 'An unexpected error occurred while communicating with the server.',
    retryable: status >= 500,
  };
}

/**
 * Execute HTTP fetch with exponential backoff and jitter for transient errors (5xx / network disconnects)
 */
export async function fetchWithRetry<T>(
  url: string,
  options: RequestInit = {},
  maxRetries = 3,
  timeoutMs = 25000
): Promise<T> {
  // Check online status before network dispatch
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    throw new BurnerApiError(
      {
        code: 'NETWORK_OFFLINE',
        message: 'You are currently offline. Please check your internet connection.',
        retryable: true,
      },
      0
    );
  }

  let attempt = 0;
  let lastError: any = null;

  while (attempt <= maxRetries) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const mergedHeaders: Record<string, string> = {
        'X-Burner-Client': 'v1',
        ...(options.headers as Record<string, string>),
      };

      const response = await fetch(url, {
        ...options,
        headers: mergedHeaders,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // Track Boot ID to detect server restarts
      const bootIdHeader = response.headers.get('X-Boot-Id');
      if (bootIdHeader) {
        if (activeServerBootId && activeServerBootId !== bootIdHeader) {
          console.warn('[Burner Room] Detected server restart (Boot ID changed)');
        }
        activeServerBootId = bootIdHeader;
      }

      // Successful 2xx response
      if (response.ok) {
        if (options.method === 'HEAD') {
          return { exists: true } as unknown as T;
        }
        const json = await response.json().catch(() => ({}));
        return json as T;
      }

      // Parse error envelope
      const status = response.status;
      const errorJson = await response.json().catch(() => ({}));
      const normalizedError = normalizeApiError(errorJson, status, bootIdHeader || undefined);

      const retryAfterHeader = response.headers.get('Retry-After');
      if (retryAfterHeader && !normalizedError.retryAfter) {
        const parsedHeader = parseInt(retryAfterHeader, 10);
        if (!isNaN(parsedHeader)) {
          normalizedError.retryAfter = parsedHeader;
        }
      }

      // 409 SLOTS_BUSY is handled by the caller with explicit Retry-After countdown
      if (status === 409) {
        const slotsError = new BurnerApiError(normalizedError, status, bootIdHeader || undefined);
        slotsError.retryable = false; // Do not rapid-retry internally; let UI handle countdown
        throw slotsError;
      }

      // Do NOT retry deterministic 4xx errors
      if (status >= 400 && status < 500) {
        throw new BurnerApiError(normalizedError, status, bootIdHeader || undefined);
      }

      // 5xx Server Errors are eligible for retry
      lastError = new BurnerApiError(normalizedError, status, bootIdHeader || undefined);
    } catch (err: any) {
      clearTimeout(timeoutId);

      if (err instanceof BurnerApiError) {
        if (!err.retryable) {
          throw err;
        }
        lastError = err;
      } else if (err.name === 'AbortError') {
        lastError = new BurnerApiError(
          {
            code: 'REQUEST_TIMEOUT',
            message: 'Request timed out. Server response took longer than expected.',
            retryable: true,
          },
          408
        );
      } else {
        lastError = new BurnerApiError(
          {
            code: 'NETWORK_ERROR',
            message: 'Network connection interrupted. Retrying...',
            retryable: true,
          },
          0
        );
      }
    }

    // Check if we can retry
    attempt++;
    if (attempt > maxRetries) {
      break;
    }

    // Exponential backoff with random jitter
    const baseDelay = Math.pow(2, attempt - 1) * 400;
    const jitter = Math.floor(Math.random() * 200);
    await new Promise((resolve) => setTimeout(resolve, baseDelay + jitter));
  }

  throw lastError || new BurnerApiError({
    code: 'NETWORK_FAILURE',
    message: 'Failed to complete request after multiple attempts.',
    retryable: true,
  });
}

export const API_BASE = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_BASE_URL)
  ? String((import.meta as any).env.VITE_API_BASE_URL).replace(/\/$/, '')
  : '';

/**
 * Client API methods
 */
export const BurnerApi = {
  /**
   * Request a fresh session PIN with sender ownership token
   */
  async getSession(ttlSeconds = 600, requestedPin?: string): Promise<SessionResponse> {
    let url = `${API_BASE}/api/session?ttl=${ttlSeconds}`;
    if (requestedPin && requestedPin.length === 4) {
      url += `&customPin=${encodeURIComponent(requestedPin)}`;
    }
    return fetchWithRetry<SessionResponse>(url);
  },

  async createSession(ttlSeconds = 600, requestedPin?: string): Promise<SessionResponse> {
    return this.getSession(ttlSeconds, requestedPin);
  },

  /**
   * Transition session to 'staged' state during sender's undo countdown
   */
  async stageSession(pin: string, senderToken: string): Promise<{ success: boolean; state: string; bootId?: string }> {
    return fetchWithRetry<{ success: boolean; state: string; bootId?: string }>(`${API_BASE}/api/session/stage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ pin, senderToken }),
    });
  },

  /**
   * Check if a 4-digit custom PIN is available
   */
  async checkPinAvailability(pin: string): Promise<CheckPinAvailabilityResponse> {
    return fetchWithRetry<CheckPinAvailabilityResponse>(`${API_BASE}/api/session/check-pin/${encodeURIComponent(pin)}`);
  },

  /**
   * Arm payload into in-memory ephemeral store and publish to 'live'
   */
  async dropPayload(payload: DropPayloadRequest): Promise<DropPayloadResponse> {
    return fetchWithRetry<DropPayloadResponse>(`${API_BASE}/api/drop`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
  },

  /**
   * Check payload metadata without burning (safe preview)
   */
  async checkPin(pin: string): Promise<CheckPayloadResponse> {
    return fetchWithRetry<CheckPayloadResponse>(`${API_BASE}/api/check/${encodeURIComponent(pin)}`);
  },

  async checkPayload(pin: string): Promise<CheckPayloadResponse> {
    return this.checkPin(pin);
  },

  /**
   * Explicit human retrieval and unlock (slot reservation)
   */
  async pickupPayload(pin: string): Promise<PickupPayloadResponse> {
    return fetchWithRetry<PickupPayloadResponse>(`${API_BASE}/api/pickup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ pin }),
    });
  },

  /**
   * Manually incinerate payload with sender ownership token
   */
  async burnPayload(pin: string, senderToken: string): Promise<{ success: boolean; message: string }> {
    return fetchWithRetry<{ success: boolean; message: string }>(`${API_BASE}/api/burn`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sender-Token': senderToken,
      },
      body: JSON.stringify({ pin, senderToken }),
    });
  },
};
