import express, { Request, Response, NextFunction } from "express";
import path from "path";
import crypto from "crypto";
import { createServer as createViteServer } from "vite";

interface StoredPayload {
  pin: string;
  senderToken: string;
  creatorIp: string;
  type: "text" | "file";
  shareMode: "burn_on_read" | "multiple_reads";
  readCount: number;
  maxReads?: number;
  sizeBytes: number;
  textContent?: string;
  file?: {
    name: string;
    size: number;
    type: string;
    dataUrl: string;
  };
  encryptedBundle?: {
    ciphertext: string;
    iv: string;
    isEncrypted: boolean;
  };
  createdAt: number;
  expiresAt: number;
  ttlSeconds: number;
  status: "pending" | "retrieved" | "expired";
}

// Global Memory and Quota Limits
const MAX_TOTAL_RAM_BYTES = 1.5 * 1024 * 1024 * 1024; // 1.5 GB global buffer ceiling
const MAX_RAM_BYTES_PER_IP = 150 * 1024 * 1024;       // 150 MB quota per IP
const MAX_ACTIVE_DROPS_PER_IP = 3;                     // Max 3 concurrent active drops per IP
const MAX_SINGLE_PAYLOAD_BYTES = 55 * 1024 * 1024;     // 55 MB max per request

let currentTotalRamBytes = 0;
const ipActiveRamBytes = new Map<string, number>();
const ipActiveSessions = new Map<string, number>();

// Ephemeral in-memory store
const payloadStore = new Map<string, StoredPayload>();
const burnedPinsStore = new Map<string, { burnedAt: number; reason: string }>();

// SSE Subscriptions for real-time pickup notifications
const sseClients = new Map<string, Set<Response>>();

// Rate limiting & Brute-force lockout state
interface RateLimitRecord {
  failedAttempts: number;
  lockedUntil: number;
  lastAttempt: number;
}
const ipPickupRateLimits = new Map<string, RateLimitRecord>();
const ipCheckRateLimits = new Map<string, RateLimitRecord>();

// Global per-PIN attempt tracking (closes distributed brute-force attacks across multiple IPs)
const pinGlobalFailedAttempts = new Map<string, number>();
const GLOBAL_PIN_MAX_FAILED_ATTEMPTS = 10; // Auto-incinerates any PIN attempted >= 10 times across all IPs

const MAX_PICKUP_FAILED_ATTEMPTS = 5;
const MAX_CHECK_FAILED_ATTEMPTS = 25; // Generous budget for non-destructive preview checks & bots
const LOCKOUT_DURATION_MS = 10 * 60 * 1000; // 10 minutes lockout

// Constant-time string comparison to prevent timing attacks
function timingSafeEqualStr(a?: string, b?: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf-8");
  const bufB = Buffer.from(b, "utf-8");
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// Log scrubber helper to mask PINs and prevent sensitive leaks
function maskPin(pin?: string): string {
  if (!pin || pin.length < 4) return "****";
  return pin.slice(0, 2) + "**";
}

// Helper to send standardized error envelopes
function sendApiError(
  res: Response,
  status: number,
  code: string,
  message: string,
  retryable?: boolean,
  retryAfter?: number
) {
  if (retryAfter) {
    res.setHeader("Retry-After", retryAfter);
  }
  return res.status(status).json({
    error: {
      code,
      message,
      retryable: retryable ?? (status >= 500 || status === 429),
      retryAfter,
    },
    // Backwards compatibility fallbacks
    errorCode: code,
  });
}
function sanitizeFilename(name: string): string {
  if (!name) return "unnamed-file";
  const sanitized = name
    .replace(/[\x00-\x1F\x7F]/g, "")
    .replace(/[/\\]/g, "_")
    .replace(/\.\./g, "_")
    .trim();
  return sanitized.length > 0 ? sanitized : "sanitized-file";
}

// Extract client IP (respecting proxy headers)
function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

// Check and record failed PIN pickup attempt
function recordFailedPickupAttempt(ip: string, pin: string): { isLocked: boolean; remainingLockSeconds: number; attempts: number; isGloballyIncinerated: boolean } {
  const now = Date.now();
  
  // Track global per-PIN attempts across all IPs
  const globalAttempts = (pinGlobalFailedAttempts.get(pin) || 0) + 1;
  pinGlobalFailedAttempts.set(pin, globalAttempts);
  
  let isGloballyIncinerated = false;
  if (globalAttempts >= GLOBAL_PIN_MAX_FAILED_ATTEMPTS) {
    isGloballyIncinerated = true;
    if (payloadStore.has(pin)) {
      broadcastSseEvent(pin, {
        type: "burned",
        reason: "global_bruteforce_limit",
        message: "PIN auto-incinerated: exceeded 10 global failed attempts across distributed sources.",
      });
      deletePayloadItem(pin, "Global brute-force threshold exceeded (10 failed attempts across all IPs).");
    }
  }

  // Track per-IP pickup attempts
  let record = ipPickupRateLimits.get(ip);
  if (!record || (record.lockedUntil < now && now - record.lastAttempt > LOCKOUT_DURATION_MS)) {
    record = { failedAttempts: 1, lockedUntil: 0, lastAttempt: now };
  } else {
    record.failedAttempts += 1;
    record.lastAttempt = now;
    if (record.failedAttempts >= MAX_PICKUP_FAILED_ATTEMPTS) {
      record.lockedUntil = now + LOCKOUT_DURATION_MS;
    }
  }
  ipPickupRateLimits.set(ip, record);

  const isLocked = record.lockedUntil > now;
  const remainingLockSeconds = isLocked ? Math.ceil((record.lockedUntil - now) / 1000) : 0;
  return { isLocked, remainingLockSeconds, attempts: record.failedAttempts, isGloballyIncinerated };
}

// Check and record failed PIN check attempt (separate generous budget for unfurlers/preview checks)
function recordFailedCheckAttempt(ip: string, pin: string): { isLocked: boolean; remainingLockSeconds: number; attempts: number } {
  const now = Date.now();
  
  // Increment global PIN count for bad checks as well
  const globalAttempts = (pinGlobalFailedAttempts.get(pin) || 0) + 1;
  pinGlobalFailedAttempts.set(pin, globalAttempts);

  let record = ipCheckRateLimits.get(ip);
  if (!record || (record.lockedUntil < now && now - record.lastAttempt > LOCKOUT_DURATION_MS)) {
    record = { failedAttempts: 1, lockedUntil: 0, lastAttempt: now };
  } else {
    record.failedAttempts += 1;
    record.lastAttempt = now;
    if (record.failedAttempts >= MAX_CHECK_FAILED_ATTEMPTS) {
      record.lockedUntil = now + LOCKOUT_DURATION_MS;
    }
  }
  ipCheckRateLimits.set(ip, record);

  const isLocked = record.lockedUntil > now;
  const remainingLockSeconds = isLocked ? Math.ceil((record.lockedUntil - now) / 1000) : 0;
  return { isLocked, remainingLockSeconds, attempts: record.failedAttempts };
}

// Reset rate-limit record on successful action
function clearPickupFailedAttempts(ip: string) {
  ipPickupRateLimits.delete(ip);
}

// Check if IP is currently locked out for pickup
function isIpPickupLockedOut(ip: string): { isLocked: boolean; remainingLockSeconds: number } {
  const now = Date.now();
  const record = ipPickupRateLimits.get(ip);
  if (!record) return { isLocked: false, remainingLockSeconds: 0 };
  if (record.lockedUntil > now) {
    return { isLocked: true, remainingLockSeconds: Math.ceil((record.lockedUntil - now) / 1000) };
  }
  return { isLocked: false, remainingLockSeconds: 0 };
}

// Check if IP is locked out for checks
function isIpCheckLockedOut(ip: string): { isLocked: boolean; remainingLockSeconds: number } {
  const now = Date.now();
  const record = ipCheckRateLimits.get(ip);
  if (!record) return { isLocked: false, remainingLockSeconds: 0 };
  if (record.lockedUntil > now) {
    return { isLocked: true, remainingLockSeconds: Math.ceil((record.lockedUntil - now) / 1000) };
  }
  return { isLocked: false, remainingLockSeconds: 0 };
}

// Broadcast SSE event to active sender connections for a PIN
function broadcastSseEvent(pin: string, eventData: object) {
  const clients = sseClients.get(pin);
  if (clients && clients.size > 0) {
    const payloadStr = `data: ${JSON.stringify(eventData)}\n\n`;
    for (const client of clients) {
      try {
        client.write(payloadStr);
      } catch {
        clients.delete(client);
      }
    }
  }
}

// Delete item and reclaim memory and IP quotas
function deletePayloadItem(pin: string, reason = "incinerated") {
  const item = payloadStore.get(pin);
  if (item) {
    currentTotalRamBytes = Math.max(0, currentTotalRamBytes - item.sizeBytes);
    
    // Reclaim per-IP quota
    if (item.creatorIp) {
      const activeBytes = ipActiveRamBytes.get(item.creatorIp) || 0;
      ipActiveRamBytes.set(item.creatorIp, Math.max(0, activeBytes - item.sizeBytes));
      
      const activeSessions = ipActiveSessions.get(item.creatorIp) || 0;
      ipActiveSessions.set(item.creatorIp, Math.max(0, activeSessions - 1));
    }

    payloadStore.delete(pin);
    burnedPinsStore.set(pin, { burnedAt: Date.now(), reason });
  }

  // Explicit SSE connection close & memory hygiene
  const clients = sseClients.get(pin);
  if (clients) {
    for (const client of clients) {
      try {
        client.write(`data: ${JSON.stringify({ type: "closed", reason })}\n\n`);
        client.end();
      } catch {
        // ignore
      }
    }
    sseClients.delete(pin);
  }
}

// Generate non-colliding 4-digit numeric PIN
function generateUniquePin(): string {
  const now = Date.now();
  // Evict expired items
  for (const [pin, item] of payloadStore.entries()) {
    if (item.expiresAt <= now) {
      deletePayloadItem(pin, "TTL expired");
    }
  }

  for (let attempt = 0; attempt < 200; attempt++) {
    const pin = Math.floor(1000 + Math.random() * 9000).toString();
    if (!payloadStore.has(pin)) {
      return pin;
    }
  }
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// Periodic cleanup every 10 seconds
setInterval(() => {
  const now = Date.now();
  for (const [pin, item] of payloadStore.entries()) {
    if (item.expiresAt <= now) {
      broadcastSseEvent(pin, { type: "expired", message: "TTL expired" });
      deletePayloadItem(pin, "TTL expired");
    }
  }

  // Cleanup rate limit records older than 15 mins
  for (const [ip, rec] of ipPickupRateLimits.entries()) {
    if (rec.lockedUntil < now && now - rec.lastAttempt > 15 * 60 * 1000) {
      ipPickupRateLimits.delete(ip);
    }
  }
  for (const [ip, rec] of ipCheckRateLimits.entries()) {
    if (rec.lockedUntil < now && now - rec.lastAttempt > 15 * 60 * 1000) {
      ipCheckRateLimits.delete(ip);
    }
  }
  // Cleanup burned pins records older than 1 hour
  for (const [pin, rec] of burnedPinsStore.entries()) {
    if (now - rec.burnedAt > 60 * 60 * 1000) {
      burnedPinsStore.delete(pin);
      pinGlobalFailedAttempts.delete(pin);
    }
  }
}, 10000);

async function startServer() {
  const app = express();
  const PORT = 3000;

  // 1. Enterprise Security Headers Middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://api.qrserver.com; connect-src 'self'; frame-ancestors 'self' https://ais.google.com https://*.google.com https://*.run.app;"
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    if (req.secure || req.headers["x-forwarded-proto"] === "https") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });

  // 2. RAM Cap Pre-Buffering Check (Validates Content-Length BEFORE body parser allocates memory)
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === "POST" && req.path === "/api/drop") {
      const contentLengthHeader = req.headers["content-length"];
      if (contentLengthHeader) {
        const contentLength = parseInt(contentLengthHeader, 10);
        if (!isNaN(contentLength)) {
          if (contentLength > MAX_SINGLE_PAYLOAD_BYTES) {
            return sendApiError(
              res,
              413,
              "PAYLOAD_TOO_LARGE",
              "Payload size exceeds maximum allowed 50MB ceiling.",
              false
            );
          }
          if (currentTotalRamBytes + contentLength > MAX_TOTAL_RAM_BYTES) {
            return sendApiError(
              res,
              507,
              "BUFFER_FULL",
              "Server temporary RAM buffer is currently at full capacity. Please try again shortly.",
              true,
              15
            );
          }
        }
      }
    }
    next();
  });

  // 3. JSON Body parser (Support up to 55MB for file uploads)
  app.use(express.json({ limit: "55mb" }));
  app.use(express.urlencoded({ extended: true, limit: "55mb" }));

  // 4. CSRF Protection Middleware for Mutating Endpoints
  app.use((req: Request, res: Response, next: NextFunction) => {
    // Only check state-mutating API routes
    if (req.method === "POST" && (req.path === "/api/drop" || req.path === "/api/pickup" || req.path === "/api/burn")) {
      const clientHeader = req.headers["x-burner-client"];
      const requestedWith = req.headers["x-requested-with"];
      const secFetchSite = req.headers["sec-fetch-site"];

      // Block cross-site simple form/fetch POSTs unless same-origin or custom client header provided
      if (secFetchSite === "cross-site") {
        return sendApiError(
          res,
          403,
          "CSRF_BLOCKED",
          "Cross-Site Request Forgery blocked. Cross-origin mutating requests are forbidden.",
          false
        );
      }

      if (!clientHeader && !requestedWith) {
        return sendApiError(
          res,
          403,
          "CSRF_HEADER_MISSING",
          "CSRF verification failed: Missing required X-Burner-Client or X-Requested-With security header.",
          false
        );
      }
    }
    next();
  });

  // --- API ROUTES ---

  // 1. Health check & System telemetry
  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({
      status: "online",
      activeSessions: payloadStore.size,
      currentRamMb: (currentTotalRamBytes / (1024 * 1024)).toFixed(2),
      maxRamMb: (MAX_TOTAL_RAM_BYTES / (1024 * 1024)).toFixed(0),
      system: "Zero-Persistence / RAM-Only Buffer",
    });
  });

  // 2. Check PIN availability (Debounced check for custom memorable PINs)
  app.get("/api/session/check-pin/:pin", (req: Request, res: Response) => {
    const pin = req.params.pin;
    if (!pin || !/^[0-9]{4}$/.test(pin)) {
      return sendApiError(res, 400, "INVALID_PIN_FORMAT", "PIN must be exactly 4 numeric digits.", false);
    }

    const burnedInfo = burnedPinsStore.get(pin);
    if (burnedInfo) {
      return res.json({ available: false, pin, message: "PIN was recently incinerated and is in cooldown." });
    }

    // Check if active in payload store
    let isTaken = false;
    for (const [storedPin] of payloadStore.entries()) {
      if (timingSafeEqualStr(storedPin, pin)) {
        isTaken = true;
        break;
      }
    }

    return res.json({
      available: !isTaken,
      pin,
      message: isTaken ? "PIN is currently occupied by an active session." : "PIN is available.",
    });
  });

  // 3. Generate / Reserve fresh session PIN with sender ownership token
  app.get("/api/session", (req: Request, res: Response) => {
    const customPin = req.query.customPin as string | undefined;
    let pin: string;

    if (customPin && /^[0-9]{4}$/.test(customPin)) {
      // Check if available
      let isTaken = false;
      for (const [storedPin] of payloadStore.entries()) {
        if (timingSafeEqualStr(storedPin, customPin)) {
          isTaken = true;
          break;
        }
      }
      if (isTaken || burnedPinsStore.has(customPin)) {
        pin = generateUniquePin();
      } else {
        pin = customPin;
      }
    } else {
      pin = generateUniquePin();
    }

    const senderToken = crypto.randomBytes(16).toString("hex");
    const rawTtl = Number(req.query.ttl || req.query.ttlSeconds);
    const ttlSeconds = !isNaN(rawTtl) && rawTtl > 0 ? Math.min(3600, Math.max(60, rawTtl)) : 600;
    const now = Date.now();
    const expiresAt = now + ttlSeconds * 1000;

    res.json({
      pin,
      senderToken,
      createdAt: now,
      expiresAt,
      ttlSeconds,
    });
  });

  // 4. Upload / Drop Payload with Pre-Buffer Memory Cap, Per-IP Quotas & Ownership
  app.post("/api/drop", (req: Request, res: Response) => {
    const ip = getClientIp(req);
    const {
      pin,
      senderToken: providedSenderToken,
      type,
      textContent,
      file,
      encryptedBundle,
      shareMode,
      maxReads,
      ttlSeconds: requestedTtl,
    } = req.body;

    if (!pin || typeof pin !== "string" || !/^[0-9]{4}$/.test(pin)) {
      return sendApiError(res, 400, "INVALID_PIN_FORMAT", "Invalid 4-digit PIN provided.", false);
    }

    if (type !== "text" && type !== "file") {
      return sendApiError(res, 400, "INVALID_PAYLOAD", "Invalid payload type specified.", false);
    }

    // Check Per-IP active concurrent sessions cap
    const currentIpSessions = ipActiveSessions.get(ip) || 0;
    if (currentIpSessions >= MAX_ACTIVE_DROPS_PER_IP) {
      return sendApiError(
        res,
        429,
        "SESSION_CAP_EXCEEDED",
        `Client session cap reached (maximum ${MAX_ACTIVE_DROPS_PER_IP} concurrent active drops per IP). Please wait for existing payloads to burn or expire.`,
        true,
        60
      );
    }

    // Estimate payload size in bytes
    let estimatedBytes = 1024; // Base metadata overhead
    if (type === "text") {
      if (encryptedBundle?.ciphertext) {
        estimatedBytes += encryptedBundle.ciphertext.length * 2;
      } else if (textContent) {
        estimatedBytes += Buffer.byteLength(textContent, "utf-8");
      } else {
        return sendApiError(res, 400, "EMPTY_PAYLOAD", "Text payload cannot be empty.", false);
      }
    } else if (type === "file") {
      if (encryptedBundle?.ciphertext) {
        estimatedBytes += encryptedBundle.ciphertext.length * 2;
      } else if (file?.dataUrl) {
        estimatedBytes += file.dataUrl.length * 2;
      } else {
        return sendApiError(res, 400, "INCOMPLETE_FILE", "File payload data is incomplete.", false);
      }
    }

    // Check Per-IP RAM Quota (150 MB per IP)
    const currentIpBytes = ipActiveRamBytes.get(ip) || 0;
    if (currentIpBytes + estimatedBytes > MAX_RAM_BYTES_PER_IP) {
      return sendApiError(
        res,
        507,
        "QUOTA_EXCEEDED",
        `Per-client RAM quota exceeded (150MB limit per IP). Active allocated: ${(currentIpBytes / (1024 * 1024)).toFixed(1)}MB.`,
        true,
        30
      );
    }

    // Check Global Server RAM Capacity Guard
    if (currentTotalRamBytes + estimatedBytes > MAX_TOTAL_RAM_BYTES) {
      return sendApiError(
        res,
        507,
        "BUFFER_FULL",
        "Server temporary RAM buffer is currently at full capacity. Please try again shortly.",
        true,
        15
      );
    }

    // Sanitize filename if present
    let sanitizedFile = file;
    if (file && file.name) {
      sanitizedFile = {
        ...file,
        name: sanitizeFilename(file.name),
      };
    }

    const senderToken = providedSenderToken || crypto.randomBytes(16).toString("hex");
    const rawTtl = Number(requestedTtl);
    const ttlSeconds = !isNaN(rawTtl) && rawTtl > 0 ? Math.min(3600, Math.max(60, rawTtl)) : 600;
    const now = Date.now();
    const expiresAt = now + ttlSeconds * 1000;

    const parsedMaxReads = Number(maxReads);
    const validMaxReads = !isNaN(parsedMaxReads) && parsedMaxReads > 0 ? Math.floor(parsedMaxReads) : undefined;

    const payload: StoredPayload = {
      pin,
      senderToken,
      creatorIp: ip,
      type,
      shareMode: shareMode === "multiple_reads" ? "multiple_reads" : "burn_on_read",
      readCount: 0,
      maxReads: validMaxReads,
      sizeBytes: estimatedBytes,
      textContent: type === "text" && !encryptedBundle ? textContent : undefined,
      file: type === "file" && !encryptedBundle ? sanitizedFile : undefined,
      encryptedBundle: encryptedBundle?.isEncrypted ? encryptedBundle : undefined,
      createdAt: now,
      expiresAt,
      ttlSeconds,
      status: "pending",
    };

    // If replacing an existing key for same PIN, adjust RAM usage
    const existing = payloadStore.get(pin);
    if (existing) {
      currentTotalRamBytes -= existing.sizeBytes;
      if (existing.creatorIp) {
        const prevBytes = ipActiveRamBytes.get(existing.creatorIp) || 0;
        ipActiveRamBytes.set(existing.creatorIp, Math.max(0, prevBytes - existing.sizeBytes));
      }
    } else {
      ipActiveSessions.set(ip, (ipActiveSessions.get(ip) || 0) + 1);
    }

    payloadStore.set(pin, payload);
    currentTotalRamBytes += estimatedBytes;
    ipActiveRamBytes.set(ip, (ipActiveRamBytes.get(ip) || 0) + estimatedBytes);

    console.log(`[Burner Room] Payload armed: PIN ${maskPin(pin)} (${type}, mode: ${payload.shareMode}, ttl: ${ttlSeconds}s)`);

    return res.json({
      success: true,
      message: "Payload armed successfully. Ready for pickup.",
      pin,
      senderToken,
      shareMode: payload.shareMode,
      maxReads: validMaxReads,
      expiresAt,
      ttlSeconds,
    });
  });

  // 5. Check PIN status (Non-destructive preview with generous unfurler budget & HEAD support)
  const handleCheckPin = (req: Request, res: Response) => {
    const ip = getClientIp(req);
    const lockout = isIpCheckLockedOut(ip);
    if (lockout.isLocked) {
      return sendApiError(
        res,
        429,
        "LOCKED_OUT",
        `Too many failed preview checks. IP temporarily locked for ${lockout.remainingLockSeconds} seconds.`,
        true,
        lockout.remainingLockSeconds
      );
    }

    const pin = req.params.pin;

    if (!pin || !/^[0-9]{4}$/.test(pin)) {
      return sendApiError(res, 400, "INVALID_PIN_FORMAT", "PIN must be exactly 4 numeric digits.", false);
    }

    // Check if this PIN was recently burned or globally incinerated
    const burnedInfo = burnedPinsStore.get(pin);
    if (burnedInfo) {
      if (burnedInfo.reason?.includes("distributed")) {
        return sendApiError(
          res,
          410,
          "DISTRIBUTED_ATTACK_BURNED",
          "Security Alert: This drop was destroyed after unusual access attempts were detected across distributed networks — not retrieved.",
          false
        );
      }
      return sendApiError(
        res,
        410,
        "PIN_BURNED_ALREADY",
        `This payload was incinerated (${burnedInfo.reason}).`,
        false
      );
    }

    let foundItem: StoredPayload | undefined;

    // Use constant-time matching to locate PIN
    for (const [storedPin, item] of payloadStore.entries()) {
      if (timingSafeEqualStr(storedPin, pin)) {
        foundItem = item;
        break;
      }
    }

    if (!foundItem) {
      const attempt = recordFailedCheckAttempt(ip, pin);
      if (attempt.isLocked) {
        return sendApiError(
          res,
          429,
          "LOCKED_OUT",
          `Too many failed preview requests. Access locked for ${attempt.remainingLockSeconds} seconds.`,
          true,
          attempt.remainingLockSeconds
        );
      }
      return sendApiError(
        res,
        404,
        "PIN_NOT_FOUND",
        `No active payload found for PIN ${pin}.`,
        false
      );
    }

    if (foundItem.expiresAt <= Date.now()) {
      deletePayloadItem(foundItem.pin, "TTL expired");
      return sendApiError(
        res,
        410,
        "PIN_EXPIRED",
        "Payload has expired and was automatically incinerated.",
        false
      );
    }

    return res.json({
      exists: true,
      type: foundItem.type,
      shareMode: foundItem.shareMode,
      readCount: foundItem.readCount,
      maxReads: foundItem.maxReads,
      expiresAt: foundItem.expiresAt,
      remainingSeconds: Math.max(0, Math.floor((foundItem.expiresAt - Date.now()) / 1000)),
      fileMeta: foundItem.file
        ? { name: foundItem.file.name, size: foundItem.file.size, type: foundItem.file.type }
        : undefined,
      isEncrypted: !!foundItem.encryptedBundle,
    });
  };

  app.get("/api/check/:pin", handleCheckPin);
  app.head("/api/check/:pin", handleCheckPin);

  // 6. Pickup Payload (Explicit human unlock with per-IP rate-limiting & global per-PIN limit)
  app.post("/api/pickup", (req: Request, res: Response) => {
    const ip = getClientIp(req);
    const lockout = isIpPickupLockedOut(ip);
    if (lockout.isLocked) {
      return sendApiError(
        res,
        429,
        "LOCKED_OUT",
        `Too many failed PIN pickup attempts. IP locked for ${lockout.remainingLockSeconds} seconds.`,
        true,
        lockout.remainingLockSeconds
      );
    }

    const { pin } = req.body;
    if (!pin || typeof pin !== "string" || !/^[0-9]{4}$/.test(pin)) {
      return sendApiError(res, 400, "INVALID_PIN_FORMAT", "4-digit numeric PIN is required.", false);
    }

    // Check if previously burned/incinerated
    const burnedInfo = burnedPinsStore.get(pin);
    if (burnedInfo) {
      if (burnedInfo.reason?.includes("distributed")) {
        return sendApiError(
          res,
          410,
          "DISTRIBUTED_ATTACK_BURNED",
          "Security Alert: This drop was destroyed after unusual access attempts were detected across distributed networks — not retrieved.",
          false
        );
      }
      return sendApiError(
        res,
        410,
        "PIN_BURNED_ALREADY",
        `Payload is no longer available (${burnedInfo.reason}).`,
        false
      );
    }

    let foundKey: string | undefined;
    let item: StoredPayload | undefined;

    // Constant-time PIN lookup
    for (const [storedPin, val] of payloadStore.entries()) {
      if (timingSafeEqualStr(storedPin, pin)) {
        foundKey = storedPin;
        item = val;
        break;
      }
    }

    if (!foundKey || !item) {
      const attempt = recordFailedPickupAttempt(ip, pin);
      if (attempt.isGloballyIncinerated) {
        return sendApiError(
          res,
          410,
          "DISTRIBUTED_ATTACK_BURNED",
          "Security Alert: This drop was destroyed after unusual access attempts were detected across distributed networks — not retrieved.",
          false
        );
      }
      if (attempt.isLocked) {
        return sendApiError(
          res,
          429,
          "LOCKED_OUT",
          `Too many failed attempts. Access locked for ${attempt.remainingLockSeconds} seconds.`,
          true,
          attempt.remainingLockSeconds
        );
      }
      return sendApiError(
        res,
        404,
        "PIN_NOT_FOUND",
        `Payload not found or already burned. (${MAX_PICKUP_FAILED_ATTEMPTS - attempt.attempts} attempts remaining)`,
        false
      );
    }

    const now = Date.now();
    if (item.expiresAt <= now) {
      deletePayloadItem(foundKey, "TTL expired");
      return sendApiError(
        res,
        410,
        "PIN_EXPIRED",
        "Session expired. Payload was automatically incinerated.",
        false
      );
    }

    // Success - clear lockout counter for IP
    clearPickupFailedAttempts(ip);

    item.readCount += 1;
    let isBurned = false;

    // Check if 1-time read OR multi-share maxReads threshold reached
    if (item.shareMode === "burn_on_read" || (item.maxReads && item.readCount >= item.maxReads)) {
      isBurned = true;
      deletePayloadItem(foundKey, "Retrieved by recipient");
      console.log(`[Burner Room] PIN ${maskPin(pin)} retrieved & BURNED.`);
    } else {
      console.log(`[Burner Room] PIN ${maskPin(pin)} retrieved (read #${item.readCount}).`);
    }

    // Broadcast SSE live event to sender
    broadcastSseEvent(pin, {
      type: "pickup",
      readCount: item.readCount,
      maxReads: item.maxReads,
      isBurned,
      timestamp: now,
    });

    // If file payload, attach safe headers
    if (item.file) {
      res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(item.file.name)}"`);
    }

    return res.json({
      success: true,
      isBurned,
      shareMode: item.shareMode,
      readCount: item.readCount,
      maxReads: item.maxReads,
      burnedAt: isBurned ? now : undefined,
      payload: {
        pin: item.pin,
        type: item.type,
        shareMode: item.shareMode,
        readCount: item.readCount,
        maxReads: item.maxReads,
        textContent: item.textContent,
        file: item.file,
        encryptedBundle: item.encryptedBundle,
        createdAt: item.createdAt,
        expiresAt: item.expiresAt,
        ttlSeconds: item.ttlSeconds,
        status: isBurned ? "retrieved" : "pending",
      },
    });
  });

  // 7. Manual Burn / Incinerate (Requires cryptographic senderToken ownership check)
  app.post("/api/burn", (req: Request, res: Response) => {
    const { pin, senderToken } = req.body;
    const headerToken = req.headers["x-sender-token"] as string | undefined;
    const activeToken = senderToken || headerToken;

    if (!pin) {
      return sendApiError(res, 400, "INVALID_PIN_FORMAT", "PIN is required.", false);
    }

    const item = payloadStore.get(pin);
    if (!item) {
      return res.json({ success: true, message: "Session already cleared from memory." });
    }

    // Strict ownership verification using constant-time comparison
    if (!activeToken || !timingSafeEqualStr(item.senderToken, activeToken)) {
      return sendApiError(
        res,
        403,
        "UNAUTHORIZED_TOKEN",
        "Forbidden: Invalid or missing sender ownership token.",
        false
      );
    }

    // Broadcast burn event before deletion
    broadcastSseEvent(pin, { type: "burned", message: "Manually incinerated by sender", timestamp: Date.now() });

    deletePayloadItem(pin, "Manually incinerated by sender");
    console.log(`[Burner Room] PIN ${maskPin(pin)} manually incinerated by authorized sender.`);

    return res.json({ success: true, message: "Payload destroyed immediately." });
  });

  // 7. Live Pickup Notifications via Server-Sent Events (SSE)
  app.get("/api/events/:pin", (req: Request, res: Response) => {
    const pin = req.params.pin;
    const token = (req.query.senderToken as string) || (req.headers["x-sender-token"] as string);

    const item = payloadStore.get(pin);
    if (!item) {
      return res.status(404).json({ error: "Session not found." });
    }

    // Authenticate sender
    if (!token || !timingSafeEqualStr(item.senderToken, token)) {
      return res.status(403).json({ error: "Unauthorized SSE connection." });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    res.write(`data: ${JSON.stringify({ type: "connected", pin: maskPin(pin) })}\n\n`);

    if (!sseClients.has(pin)) {
      sseClients.set(pin, new Set());
    }
    sseClients.get(pin)!.add(res);

    req.on("close", () => {
      const clients = sseClients.get(pin);
      if (clients) {
        clients.delete(res);
        if (clients.size === 0) {
          sseClients.delete(pin);
        }
      }
    });
  });

  // --- VITE MIDDLEWARE ---
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Burner Room server running on port ${PORT}`);
  });
}

startServer();
