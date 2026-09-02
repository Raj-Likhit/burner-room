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

  constructor(detail: ApiErrorDetail, status: number = 400) {
    super(detail.message);
    this.name = 'BurnerApiError';
    this.code = detail.code;
    this.retryable = detail.retryable ?? false;
    this.retryAfter = detail.retryAfter;
    this.status = status;
  }
}

/**
 * Standardized client-side error normalizer
 */
export function normalizeApiError(errorObj: any, status: number = 0): ApiErrorDetail {
  if (errorObj?.error && typeof errorObj.error === 'object' && errorObj.error.code) {
    return {
      code: errorObj.error.code,
      message: errorObj.error.message || 'An unexpected error occurred.',
      retryable: errorObj.error.retryable ?? (status >= 500 || status === 429),
      retryAfter: errorObj.error.retryAfter,
    };
  }

  // Handle fallback string errors from server
  if (typeof errorObj?.error === 'string') {
    return {
      code: errorObj.errorCode || (status === 429 ? 'RATE_LIMITED' : 'API_ERROR'),
      message: errorObj.error,
      retryable: status >= 500 || status === 429,
      retryAfter: errorObj.retryAfter,
    };
  }

  if (typeof errorObj?.message === 'string') {
    return {
      code: errorObj.code || 'API_ERROR',
      message: errorObj.message,
      retryable: status >= 500,
    };
  }

  // Fallback based on HTTP status
  if (status === 404) {
    return {
      code: 'PIN_NOT_FOUND',
      message: 'No active payload found for this PIN. It may have never existed or was already purged.',
      retryable: false,
    };
  }
  if (status === 410) {
    return {
      code: 'PIN_EXPIRED',
      message: 'This payload has expired or was already retrieved and incinerated.',
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
  timeoutMs = 15000
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

      // Successful 2xx response
      if (response.ok) {
        // Check if HEAD request
        if (options.method === 'HEAD') {
          return { exists: true } as unknown as T;
        }
        const json = await response.json().catch(() => ({}));
        return json as T;
      }

      // Parse error envelope
      const status = response.status;
      const errorJson = await response.json().catch(() => ({}));
      const normalizedError = normalizeApiError(errorJson, status);

      // Read Retry-After header if present
      const retryAfterHeader = response.headers.get('Retry-After');
      if (retryAfterHeader && !normalizedError.retryAfter) {
        const parsedHeader = parseInt(retryAfterHeader, 10);
        if (!isNaN(parsedHeader)) {
          normalizedError.retryAfter = parsedHeader;
        }
      }

      // Do NOT retry real 4xx rejections (400, 403, 404, 410, 413, 429)
      if (status >= 400 && status < 500) {
        throw new BurnerApiError(normalizedError, status);
      }

      // 5xx Server Errors are eligible for retry
      lastError = new BurnerApiError(normalizedError, status);
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
            message: 'Request timed out. Server response took longer than 15 seconds.',
            retryable: true,
          },
          408
        );
      } else {
        lastError = new BurnerApiError(
          {
            code: 'NETWORK_ERROR',
            message: 'Network connection interrupted. Retrying upload...',
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

    // Exponential backoff with random jitter (e.g. 400ms, 800ms, 1600ms + 0-200ms jitter)
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

/**
 * Client API methods
 */
export const BurnerApi = {
  /**
   * Request a fresh session PIN with sender ownership token
   */
  async getSession(ttlSeconds = 600, requestedPin?: string): Promise<SessionResponse> {
    let url = `/api/session?ttl=${ttlSeconds}`;
    if (requestedPin && requestedPin.length === 4) {
      url += `&customPin=${encodeURIComponent(requestedPin)}`;
    }
    return fetchWithRetry<SessionResponse>(url);
  },

  /**
   * Alias for getSession
   */
  async createSession(ttlSeconds = 600, requestedPin?: string): Promise<SessionResponse> {
    return this.getSession(ttlSeconds, requestedPin);
  },

  /**
   * Check if a 4-digit custom PIN is available
   */
  async checkPinAvailability(pin: string): Promise<CheckPinAvailabilityResponse> {
    return fetchWithRetry<CheckPinAvailabilityResponse>(`/api/session/check-pin/${encodeURIComponent(pin)}`);
  },

  /**
   * Arm payload into in-memory ephemeral store
   */
  async dropPayload(payload: DropPayloadRequest): Promise<DropPayloadResponse> {
    return fetchWithRetry<DropPayloadResponse>('/api/drop', {
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
    return fetchWithRetry<CheckPayloadResponse>(`/api/check/${encodeURIComponent(pin)}`);
  },

  /**
   * Alias for checkPin
   */
  async checkPayload(pin: string): Promise<CheckPayloadResponse> {
    return this.checkPin(pin);
  },

  /**
   * Explicit human retrieval and unlock
   */
  async pickupPayload(pin: string): Promise<PickupPayloadResponse> {
    return fetchWithRetry<PickupPayloadResponse>('/api/pickup', {
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
    return fetchWithRetry<{ success: boolean; message: string }>('/api/burn', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sender-Token': senderToken,
      },
      body: JSON.stringify({ pin, senderToken }),
    });
  },
};
