import express, { Request, Response, NextFunction } from "express";
import crypto from "node:crypto";

// Unique Boot ID to detect server restarts across client sessions
export const BOOT_ID = crypto.randomUUID();

export type SessionState = "reserved" | "staged" | "live" | "closed";

export interface InFlightLease {
  leaseExpiresAt: number;
  res?: Response;
  startedAt: number;
}

export interface StoredPayload {
  pin: string;
  senderToken: string;
  creatorIp: string;
  idempotencyKey?: string;
  state: SessionState;
  type: "text" | "file";
  shareMode: "burn_on_read" | "multiple_reads";
  completed: number;
  maxReads: number | null; // null = unlimited
  inFlight: Map<string, InFlightLease>; // reservationId -> InFlightLease
  sizeBytes: number;
  textContent?: string;
  file?: {
    name: string;
    size: number;
    type: string;
    dataUrl?: string;
  };
  encryptedBundle?: {
    ciphertext: string;
    iv: string;
    isEncrypted: boolean;
    pinKeyBundle?: {
      ciphertext: string;
      iv: string;
      salt: string;
    };
  };
  keyVerificationBlob?: {
    ciphertext: string;
    iv: string;
  };
  keyMode: "fragment" | "pin";
  createdAt: number;
  stagedAt: number;
  expiresAt: number;
  ttlSeconds: number;
  burnedAt?: number;
  burnReason?: string;
  isWiped?: boolean;
}

// Global Memory and Quota Limits
const MAX_TOTAL_RAM_BYTES = 1.5 * 1024 * 1024 * 1024; // 1.5 GB global buffer ceiling
const MAX_RAM_BYTES_PER_IP = 150 * 1024 * 1024;       // 150 MB quota per IP
const MAX_ACTIVE_DROPS_PER_IP = 25;                    // Max concurrent active drops per IP
const MAX_SINGLE_PAYLOAD_BYTES = 55 * 1024 * 1024;     // 55 MB max per request
const LEASE_MS = 35000;                               // 35s in-flight lease for download streaming
const STAGED_MAX_AGE_MS = 120000;                     // 2 min max age for reserved/staged sessions before reaper
const FORCE_DRAIN_GRACE_MS = 45000;                   // 45s grace period for closed sessions before forced drain

let currentTotalRamBytes = 0;
const ipActiveRamBytes = new Map<string, number>();
const ipActiveSessions = new Map<string, number>();

// Ephemeral in-memory store
export const sessions = new Map<string, StoredPayload>();
export const burnedPinsStore = new Map<string, { burnedAt: number; reason: string }>();

// SSE Subscriptions for real-time pickup and deletion notifications
export const sseClients = new Map<string, Set<Response>>();

// Rate limiting & Brute-force lockout state
interface RateLimitRecord {
  failedAttempts: number;
  lockedUntil: number;
  lastAttempt: number;
}
export const ipPickupRateLimits = new Map<string, RateLimitRecord>();
export const ipCheckRateLimits = new Map<string, RateLimitRecord>();

// Per-PIN attempt tracking: triggers cooldown + sender alert (DOES NOT auto-incinerate live drops)
interface PinCooldownRecord {
  failedAttempts: number;
  cooldownUntil: number;
  lastAttempt: number;
}
export const pinCooldowns = new Map<string, PinCooldownRecord>();
const PIN_COOLDOWN_FAILED_THRESHOLD = 5;
const PIN_COOLDOWN_DURATION_MS = 60 * 1000;

const MAX_PICKUP_FAILED_ATTEMPTS = 5;
const MAX_CHECK_FAILED_ATTEMPTS = 25;
const LOCKOUT_DURATION_MS = 10 * 60 * 1000;

// Constant-time string comparison to prevent timing attacks
export function timingSafeEqualStr(a?: string, b?: string): boolean {
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
export function maskPin(pin?: string): string {
  if (!pin || pin.length < 4) return "****";
  return pin.slice(0, 2) + "**";
}

// Standardized API error envelopes
export function sendApiError(
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
    errorCode: code,
    bootId: BOOT_ID,
  });
}

export function sanitizeFilename(name: string): string {
  if (!name) return "unnamed-file";
  const sanitized = name
    .replace(/[\x00-\x1F\x7F\u200E\u200F\u202A-\u202E]/g, "")
    .replace(/[/\\]/g, "_")
    .replace(/\.\./g, "_")
    .trim()
    .slice(0, 255);
  return sanitized.length > 0 ? sanitized : "sanitized-file";
}

// Normalize IP address (normalizes IPv6 to /64 subnet prefix and strips IPv4-mapped IPv6)
export function normalizeIp(rawIp: string): string {
  let ip = (rawIp || "").trim();
  if (ip.startsWith("::ffff:")) {
    ip = ip.slice(7);
  }
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) {
    return ip;
  }
  if (ip.includes(":")) {
    const parts = ip.split(":");
    const prefix = parts.slice(0, 4).join(":");
    return `${prefix}::/64`;
  }
  return ip || "127.0.0.1";
}

// Extract client IP respecting Express trust proxy and IPv6 /64 normalization
export function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  let rawIp = "";
  if (typeof forwarded === "string") {
    rawIp = forwarded.split(",")[0].trim();
  } else {
    rawIp = req.ip || req.socket.remoteAddress || "127.0.0.1";
  }
  return normalizeIp(rawIp);
}

// Check and record failed PIN pickup attempt
export function recordFailedPickupAttempt(
  ip: string,
  pin: string
): { isLocked: boolean; remainingLockSeconds: number; attempts: number; isPinCoolingDown: boolean; remainingCooldownSeconds: number } {
  const now = Date.now();

  let pinRec = pinCooldowns.get(pin);
  if (!pinRec || (pinRec.cooldownUntil < now && now - pinRec.lastAttempt > 15 * 60 * 1000)) {
    pinRec = { failedAttempts: 1, cooldownUntil: 0, lastAttempt: now };
  } else {
    pinRec.failedAttempts += 1;
    pinRec.lastAttempt = now;
  }

  let isPinCoolingDown = false;
  if (pinRec.failedAttempts >= PIN_COOLDOWN_FAILED_THRESHOLD) {
    pinRec.cooldownUntil = Math.max(pinRec.cooldownUntil, now + PIN_COOLDOWN_DURATION_MS);
    isPinCoolingDown = true;

    broadcastSseEvent(pin, {
      type: "security_alert",
      warning: "PIN_COOLDOWN_ACTIVATED",
      message: `Security Notice: Multiple failed PIN attempts detected for code ${maskPin(pin)}. PIN is in a 60-second cooldown to block brute-force attempts.`,
      cooldownSeconds: 60,
      timestamp: now,
    });
  }
  pinCooldowns.set(pin, pinRec);

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
  const remainingCooldownSeconds = pinRec.cooldownUntil > now ? Math.ceil((pinRec.cooldownUntil - now) / 1000) : 0;
  return { isLocked, remainingLockSeconds, attempts: record.failedAttempts, isPinCoolingDown, remainingCooldownSeconds };
}

// Check and record failed PIN check attempt
export function recordFailedCheckAttempt(ip: string, pin: string): { isLocked: boolean; remainingLockSeconds: number; attempts: number } {
  const now = Date.now();

  let pinRec = pinCooldowns.get(pin);
  if (!pinRec || (pinRec.cooldownUntil < now && now - pinRec.lastAttempt > 15 * 60 * 1000)) {
    pinRec = { failedAttempts: 1, cooldownUntil: 0, lastAttempt: now };
  } else {
    pinRec.failedAttempts += 1;
    pinRec.lastAttempt = now;
  }
  if (pinRec.failedAttempts >= PIN_COOLDOWN_FAILED_THRESHOLD) {
    pinRec.cooldownUntil = Math.max(pinRec.cooldownUntil, now + PIN_COOLDOWN_DURATION_MS);
    broadcastSseEvent(pin, {
      type: "security_alert",
      warning: "PIN_COOLDOWN_ACTIVATED",
      message: `Security Notice: Multiple failed preview checks for PIN ${maskPin(pin)}. PIN temporarily cooling down for 60s.`,
      cooldownSeconds: 60,
      timestamp: now,
    });
  }
  pinCooldowns.set(pin, pinRec);

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

export function isPinInCooldown(pin: string): { inCooldown: boolean; remainingSeconds: number } {
  const now = Date.now();
  const rec = pinCooldowns.get(pin);
  if (rec && rec.cooldownUntil > now) {
    return { inCooldown: true, remainingSeconds: Math.ceil((rec.cooldownUntil - now) / 1000) };
  }
  return { inCooldown: false, remainingSeconds: 0 };
}

export function clearPickupFailedAttempts(ip: string) {
  ipPickupRateLimits.delete(ip);
}

export function isIpPickupLockedOut(ip: string): { isLocked: boolean; remainingLockSeconds: number } {
  const now = Date.now();
  const record = ipPickupRateLimits.get(ip);
  if (!record) return { isLocked: false, remainingLockSeconds: 0 };
  if (record.lockedUntil > now) {
    return { isLocked: true, remainingLockSeconds: Math.ceil((record.lockedUntil - now) / 1000) };
  }
  return { isLocked: false, remainingLockSeconds: 0 };
}

export function isIpCheckLockedOut(ip: string): { isLocked: boolean; remainingLockSeconds: number } {
  const now = Date.now();
  const record = ipCheckRateLimits.get(ip);
  if (!record) return { isLocked: false, remainingLockSeconds: 0 };
  if (record.lockedUntil > now) {
    return { isLocked: true, remainingLockSeconds: Math.ceil((record.lockedUntil - now) / 1000) };
  }
  return { isLocked: false, remainingLockSeconds: 0 };
}

// Broadcast SSE event to active connections for a PIN
export function broadcastSseEvent(pin: string, eventData: object) {
  const clients = sseClients.get(pin);
  if (clients && clients.size > 0) {
    const payloadStr = `data: ${JSON.stringify({ ...eventData, bootId: BOOT_ID })}\n\n`;
    for (const client of clients) {
      try {
        client.write(payloadStr);
      } catch {
        clients.delete(client);
      }
    }
  }
}

export function reserveSlot(s: StoredPayload, res?: Response, now = Date.now()): string | "FULL" | "GONE" {
  if (s.state !== "live" || now >= s.expiresAt) return "GONE";
  if (s.maxReads !== null && (s.completed + s.inFlight.size) >= s.maxReads) return "FULL";
  const reservationId = crypto.randomUUID();
  s.inFlight.set(reservationId, {
    leaseExpiresAt: now + LEASE_MS,
    res,
    startedAt: now,
  });
  return reservationId;
}

export function commitSlot(s: StoredPayload, reservationId: string) {
  if (!s.inFlight.delete(reservationId)) return;
  s.completed++;
  
  const isLimitReached = s.maxReads !== null && s.completed >= s.maxReads;

  broadcastSseEvent(s.pin, {
    type: "pickup",
    readCount: s.completed,
    maxReads: s.maxReads,
    inFlightCount: s.inFlight.size,
    isBurned: isLimitReached,
    reason: isLimitReached ? "Download limit reached" : undefined,
    message: isLimitReached ? "File has been deleted." : `Download completed (${s.completed} of ${s.maxReads || 'unlimited'}).`,
    timestamp: Date.now(),
  });

  if (s.state === "live" && isLimitReached) {
    burnSession(s, "Download limit reached");
  }
  drainCheck(s);
}

export function releaseSlot(s: StoredPayload, reservationId: string) {
  if (!s.inFlight.delete(reservationId)) return;
  
  broadcastSseEvent(s.pin, {
    type: "release",
    readCount: s.completed,
    maxReads: s.maxReads,
    inFlightCount: s.inFlight.size,
    timestamp: Date.now(),
  });
  
  drainCheck(s);
}

// Drain check: Only zeros-out and reclaims memory when ALL active in-flight streams have drained
export function drainCheck(s: StoredPayload) {
  if (s.state !== "closed") return;
  if (s.inFlight.size > 0) return;
  if (s.isWiped) return;
  s.isWiped = true;

  if (s.file?.dataUrl) s.file.dataUrl = "";
  if (s.textContent) s.textContent = "";
  if (s.encryptedBundle?.ciphertext) s.encryptedBundle.ciphertext = "";

  currentTotalRamBytes = Math.max(0, currentTotalRamBytes - s.sizeBytes);
  if (s.creatorIp) {
    const curRam = ipActiveRamBytes.get(s.creatorIp) || 0;
    ipActiveRamBytes.set(s.creatorIp, Math.max(0, curRam - s.sizeBytes));
    const curSessions = ipActiveSessions.get(s.creatorIp) || 0;
    ipActiveSessions.set(s.creatorIp, Math.max(0, curSessions - 1));
  }

  sessions.delete(s.pin);

  setTimeout(() => {
    const clients = sseClients.get(s.pin);
    if (clients) {
      for (const client of clients) {
        try {
          client.write(`data: ${JSON.stringify({ type: "closed", message: "File has been deleted." })}\n\n`);
          client.end();
        } catch {
          // ignore
        }
      }
      sseClients.delete(s.pin);
    }
  }, 600);
}

export function burnSession(s: StoredPayload, reason = "incinerated") {
  if (s.state === "closed") return;
  s.state = "closed";
  s.burnedAt = Date.now();
  s.burnReason = reason;
  burnedPinsStore.set(s.pin, { burnedAt: Date.now(), reason });

  broadcastSseEvent(s.pin, {
    type: "burned",
    isBurned: true,
    reason,
    message: "File has been deleted.",
    timestamp: Date.now(),
  });

  drainCheck(s);
}

export function allocateSession(creatorIp: string, requestedTtlSeconds = 600, customPin?: string): StoredPayload {
  const now = Date.now();
  const ttlSeconds = Math.min(3600, Math.max(1, requestedTtlSeconds));
  const expiresAt = now + ttlSeconds * 1000;
  const senderToken = crypto.randomBytes(16).toString("hex");

  let pin = "";
  if (customPin && /^[0-9]{4}$/.test(customPin)) {
    if (!sessions.has(customPin) && !burnedPinsStore.has(customPin)) {
      pin = customPin;
    }
  }

  if (!pin) {
    for (let i = 0; i < 1000; i++) {
      const candidate = String(crypto.randomInt(0, 10000)).padStart(4, "0");
      if (!sessions.has(candidate) && !burnedPinsStore.has(candidate)) {
        pin = candidate;
        break;
      }
    }
  }

  if (!pin) {
    pin = String(crypto.randomInt(0, 10000)).padStart(4, "0");
  }

  const newSession: StoredPayload = {
    pin,
    senderToken,
    creatorIp,
    state: "reserved",
    type: "text",
    shareMode: "burn_on_read",
    completed: 0,
    maxReads: 1,
    inFlight: new Map(),
    sizeBytes: 1024,
    keyMode: "pin",
    createdAt: now,
    stagedAt: now,
    expiresAt,
    ttlSeconds,
  };

  sessions.set(pin, newSession);
  return newSession;
}

// Periodic background sweeper
const sweeperInterval = setInterval(() => {
  const now = Date.now();

  for (const [pin, s] of sessions.entries()) {
    // 1. Expire stale in-flight leases (skip active streaming responses)
    for (const [resId, lease] of s.inFlight.entries()) {
      const isResOpen = lease.res && !lease.res.writableEnded && !lease.res.destroyed;
      if (isResOpen) {
        lease.leaseExpiresAt = now + LEASE_MS;
        continue;
      }
      if (now > lease.leaseExpiresAt) {
        s.inFlight.delete(resId);
        broadcastSseEvent(s.pin, {
          type: "lease_expired",
          readCount: s.completed,
          inFlightCount: s.inFlight.size,
        });
        drainCheck(s);
      }
    }

    // 2. Reaper for abandoned 'reserved' or 'staged' sessions
    if ((s.state === "reserved" || s.state === "staged") && now - s.stagedAt > STAGED_MAX_AGE_MS) {
      sessions.delete(pin);
      continue;
    }

    // 3. Lazy expiry for live sessions
    if (s.state === "live" && now >= s.expiresAt) {
      burnSession(s, "TTL expired");
      continue;
    }

    // 4. Force drain for closed sessions
    if (s.state === "closed" && !s.isWiped && s.burnedAt && now - s.burnedAt > FORCE_DRAIN_GRACE_MS) {
      s.inFlight.clear();
      drainCheck(s);
    }
  }

  // Cleanup rate limits
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
  for (const [pin, rec] of pinCooldowns.entries()) {
    if (rec.cooldownUntil < now && now - rec.lastAttempt > 15 * 60 * 1000) {
      pinCooldowns.delete(pin);
    }
  }
  for (const [pin, rec] of burnedPinsStore.entries()) {
    if (now - rec.burnedAt > 60 * 60 * 1000) {
      burnedPinsStore.delete(pin);
    }
  }

  // Memory reconciliation
  let calculatedRam = 0;
  const ipRamSum = new Map<string, number>();
  const ipSessSum = new Map<string, number>();

  for (const [, s] of sessions.entries()) {
    if (s.state !== "closed" || !s.isWiped) {
      calculatedRam += s.sizeBytes;
      if (s.creatorIp) {
        ipRamSum.set(s.creatorIp, (ipRamSum.get(s.creatorIp) || 0) + s.sizeBytes);
        ipSessSum.set(s.creatorIp, (ipSessSum.get(s.creatorIp) || 0) + 1);
      }
    }
  }
  currentTotalRamBytes = calculatedRam;
  for (const [ip] of ipActiveRamBytes.keys()) {
    if (!ipRamSum.has(ip)) {
      ipActiveRamBytes.delete(ip);
      ipActiveSessions.delete(ip);
    } else {
      ipActiveRamBytes.set(ip, ipRamSum.get(ip) || 0);
      ipActiveSessions.set(ip, ipSessSum.get(ip) || 0);
    }
  }
}, 5000);

if (typeof sweeperInterval !== "undefined" && sweeperInterval && "unref" in sweeperInterval) {
  (sweeperInterval as any).unref();
}

export const apiApp = express();

const trustProxyEnv = process.env.TRUST_PROXY;
if (trustProxyEnv) {
  const num = parseInt(trustProxyEnv, 10);
  apiApp.set("trust proxy", isNaN(num) ? trustProxyEnv : num);
} else {
  apiApp.set("trust proxy", 1);
}

// CORS Middleware
apiApp.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, HEAD, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, X-Burner-Client, X-Sender-Token, X-Requested-With, Range, Accept"
    );
    res.setHeader(
      "Access-Control-Expose-Headers",
      "X-Boot-Id, Retry-After, Content-Disposition, Content-Length"
    );
  }
  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }
  next();
});

// Tag responses with BOOT_ID
apiApp.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("X-Boot-Id", BOOT_ID);
  next();
});

// Security Headers Middleware
apiApp.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://api.qrserver.com; connect-src 'self'; frame-ancestors 'self' https://ais.google.com https://*.google.com https://*.run.app;"
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if (req.secure || req.headers["x-forwarded-proto"] === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

// Size limit check & dynamic streaming byte counter before body parsing
apiApp.use((req: Request, res: Response, next: NextFunction) => {
  const isUploadPath = req.path.endsWith("/drop") || req.path.endsWith("/download-stream");
  if (req.method === "POST" && isUploadPath) {
    const contentLengthHeader = req.headers["content-length"];
    if (contentLengthHeader) {
      const contentLength = parseInt(contentLengthHeader, 10);
      if (!isNaN(contentLength)) {
        if (contentLength > MAX_SINGLE_PAYLOAD_BYTES) {
          return sendApiError(
            res,
            413,
            "PAYLOAD_TOO_LARGE",
            "Payload size exceeds maximum allowed 55MB ceiling.",
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

    let streamedBytes = 0;
    let aborted = false;
    const idleTimeout = setTimeout(() => {
      if (!aborted && !res.headersSent) {
        aborted = true;
        req.destroy();
      }
    }, 60000);

    req.on("data", (chunk: Buffer) => {
      streamedBytes += chunk.length;
      if (streamedBytes > MAX_SINGLE_PAYLOAD_BYTES && !aborted) {
        aborted = true;
        clearTimeout(idleTimeout);
        req.pause();
        sendApiError(res, 413, "PAYLOAD_TOO_LARGE", "Streamed payload exceeds 55MB ceiling.", false);
        req.destroy();
      }
    });

    req.on("end", () => clearTimeout(idleTimeout));
    req.on("close", () => clearTimeout(idleTimeout));
  }
  next();
});

// JSON Body Parser with strict Error Handling
apiApp.use(express.json({ limit: "55mb" }));
apiApp.use(express.urlencoded({ extended: true, limit: "55mb" }));
apiApp.use((err: any, _req: Request, res: Response, next: NextFunction) => {
  if (err) {
    if (err.type === "entity.too.large" || err.status === 413) {
      return sendApiError(res, 413, "PAYLOAD_TOO_LARGE", "Payload size exceeds 55MB limit.", false);
    }
    if (err instanceof SyntaxError && "body" in err) {
      return sendApiError(res, 400, "INVALID_JSON", "Malformed JSON request body.", false);
    }
    return sendApiError(res, 500, "INTERNAL_ERROR", err.message || "An error occurred.", false);
  }
  next();
});

// CSRF Protection for state-mutating POST requests
apiApp.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method === "POST" && (req.path.startsWith("/api/") || !req.path.includes("."))) {
    const clientHeader = req.headers["x-burner-client"];
    const requestedWith = req.headers["x-requested-with"];
    const secFetchSite = req.headers["sec-fetch-site"];

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
        "CSRF verification failed: Missing required X-Burner-Client security header.",
        false
      );
    }
  }
  next();
});

// -------------------------------------------------------------
// API ROUTER (Mounts on both /api/* and root paths)
// -------------------------------------------------------------
const router = express.Router();

// Health check
router.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "online",
    bootId: BOOT_ID,
    activeSessions: sessions.size,
    currentRamMb: (currentTotalRamBytes / (1024 * 1024)).toFixed(2),
    maxRamMb: (MAX_TOTAL_RAM_BYTES / (1024 * 1024)).toFixed(0),
    system: "Zero-Persistence / RAM-Only Buffer",
  });
});

// Check PIN availability
router.get("/session/check-pin/:pin", (req: Request, res: Response) => {
  const pin = req.params.pin;
  if (!pin || !/^[0-9]{4}$/.test(pin)) {
    return sendApiError(res, 400, "INVALID_PIN_FORMAT", "PIN must be exactly 4 numeric digits.", false);
  }

  const burnedInfo = burnedPinsStore.get(pin);
  if (burnedInfo) {
    return res.json({ available: false, pin, message: "PIN was recently incinerated and is in cooldown." });
  }

  let isTaken = false;
  for (const [storedPin] of sessions.entries()) {
    if (timingSafeEqualStr(storedPin, pin)) {
      isTaken = true;
      break;
    }
  }

  return res.json({
    available: !isTaken,
    pin,
    bootId: BOOT_ID,
    message: isTaken ? "PIN is currently occupied." : "PIN is available.",
  });
});

// Allocate fresh session PIN
router.get("/session", (req: Request, res: Response) => {
  const ip = getClientIp(req);
  const customPin = req.query.customPin as string | undefined;
  const rawTtl = Number(req.query.ttl || req.query.ttlSeconds);
  const ttlSeconds = !isNaN(rawTtl) && rawTtl > 0 ? Math.min(3600, Math.max(1, rawTtl)) : 600;

  const session = allocateSession(ip, ttlSeconds, customPin);
  const remainingMs = Math.max(0, session.expiresAt - Date.now());

  res.json({
    pin: session.pin,
    senderToken: session.senderToken,
    state: session.state,
    bootId: BOOT_ID,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    remainingMs,
    ttlSeconds: session.ttlSeconds,
  });
});

// Mark session as 'staged' during undo window
router.post("/session/stage", (req: Request, res: Response) => {
  const { pin, senderToken } = req.body;
  if (!pin || !senderToken) {
    return sendApiError(res, 400, "INVALID_REQUEST", "PIN and senderToken required.", false);
  }

  const session = sessions.get(pin);
  if (!session || !timingSafeEqualStr(session.senderToken, senderToken)) {
    return sendApiError(res, 404, "PIN_NOT_FOUND", "Session not found or invalid sender token.", false);
  }

  if (session.state === "reserved" || session.state === "staged") {
    session.state = "staged";
    session.stagedAt = Date.now();
  }

  res.json({
    success: true,
    pin: session.pin,
    state: session.state,
    bootId: BOOT_ID,
    remainingMs: Math.max(0, session.expiresAt - Date.now()),
  });
});

// Drop Payload (Transitions session to 'live')
router.post("/drop", (req: Request, res: Response) => {
  const ip = getClientIp(req);
  const {
    pin,
    senderToken,
    type,
    textContent,
    file,
    shareMode = "burn_on_read",
    maxReads,
    ttlSeconds: customTtl,
    idempotencyKey,
    encryptedBundle,
    keyVerificationBlob,
    keyMode = "pin",
  } = req.body;

  if (!pin || !senderToken) {
    return sendApiError(res, 400, "INVALID_REQUEST", "PIN and senderToken are required.", false);
  }

  let session: StoredPayload | undefined;
  for (const [storedPin, item] of sessions.entries()) {
    if (timingSafeEqualStr(storedPin, pin)) {
      session = item;
      break;
    }
  }

  if (session && idempotencyKey && session.idempotencyKey === idempotencyKey && session.state === "live") {
    return res.json({
      success: true,
      message: "Ready to share.",
      pin: session.pin,
      senderToken: session.senderToken,
      state: session.state,
      bootId: BOOT_ID,
      shareMode: session.shareMode,
      maxReads: session.maxReads,
      remainingMs: Math.max(0, session.expiresAt - Date.now()),
      expiresAt: session.expiresAt,
      ttlSeconds: session.ttlSeconds,
    });
  }

  if (!session || !timingSafeEqualStr(session.senderToken, senderToken)) {
    return sendApiError(res, 404, "SESSION_NOT_FOUND", "No reserved session found for this PIN and token.", false);
  }

  if (session.state !== "reserved" && session.state !== "staged") {
    return sendApiError(res, 409, "INVALID_STATE", `Session is already in state '${session.state}'.`, false);
  }

  if (type !== "text" && type !== "file") {
    return sendApiError(res, 400, "INVALID_TYPE", "Payload type must be 'text' or 'file'.", false);
  }

  let estimatedBytes = 0;
  if (type === "text") {
    if (!textContent && !encryptedBundle?.ciphertext) {
      return sendApiError(res, 400, "EMPTY_PAYLOAD", "Text content cannot be empty.", false);
    }
    estimatedBytes = Buffer.byteLength(textContent || encryptedBundle?.ciphertext || "", "utf-8");
  } else if (type === "file") {
    if (!file || (!file.dataUrl && !encryptedBundle?.ciphertext)) {
      return sendApiError(res, 400, "EMPTY_PAYLOAD", "File content cannot be empty.", false);
    }
    estimatedBytes = file.size || Buffer.byteLength(file.dataUrl || encryptedBundle?.ciphertext || "", "utf-8");
  }

  if (estimatedBytes > MAX_SINGLE_PAYLOAD_BYTES) {
    return sendApiError(res, 413, "PAYLOAD_TOO_LARGE", "File exceeds the 50MB RAM buffer limit.", false);
  }

  const currentIpBytes = ipActiveRamBytes.get(ip) || 0;
  if (currentIpBytes + estimatedBytes > MAX_RAM_BYTES_PER_IP) {
    return sendApiError(
      res,
      429,
      "QUOTA_EXCEEDED",
      `Per-client RAM quota exceeded (150MB limit per IP).`,
      false
    );
  }

  const now = Date.now();
  const rawTtl = Number(customTtl);
  const ttlSeconds = !isNaN(rawTtl) && rawTtl > 0 ? Math.min(3600, Math.max(1, rawTtl)) : 600;
  const expiresAt = now + ttlSeconds * 1000;

  let validMaxReads: number | null = 1;
  if (shareMode === "multiple_reads") {
    validMaxReads = typeof maxReads === "number" && maxReads > 0 ? maxReads : null;
  }

  session.type = type;
  session.textContent = textContent;
  session.file = file ? {
    name: sanitizeFilename(file.name),
    size: file.size,
    type: file.type || "application/octet-stream",
    dataUrl: file.dataUrl,
  } : undefined;
  session.encryptedBundle = encryptedBundle;
  session.keyVerificationBlob = keyVerificationBlob;
  session.keyMode = keyMode;
  session.shareMode = shareMode;
  session.maxReads = validMaxReads;
  session.completed = 0;
  session.sizeBytes = estimatedBytes;
  session.state = "live";
  session.idempotencyKey = idempotencyKey;
  session.expiresAt = expiresAt;
  session.ttlSeconds = ttlSeconds;

  currentTotalRamBytes += estimatedBytes;
  ipActiveRamBytes.set(ip, (ipActiveRamBytes.get(ip) || 0) + estimatedBytes);
  ipActiveSessions.set(ip, (ipActiveSessions.get(ip) || 0) + 1);

  const remainingMs = Math.max(0, expiresAt - now);

  broadcastSseEvent(pin, {
    type: "live",
    pin,
    remainingMs,
    shareMode: session.shareMode,
    maxReads: session.maxReads,
  });

  return res.json({
    success: true,
    message: "Ready to share.",
    pin,
    senderToken: session.senderToken,
    state: session.state,
    bootId: BOOT_ID,
    shareMode: session.shareMode,
    maxReads: validMaxReads,
    remainingMs,
    expiresAt,
    ttlSeconds,
  });
});

// Non-destructive check on PIN
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

  const cooldown = isPinInCooldown(pin);
  if (cooldown.inCooldown) {
    return sendApiError(
      res,
      429,
      "PIN_COOLDOWN",
      `PIN is temporarily in cooldown due to multiple failed attempts. Please retry in ${cooldown.remainingSeconds}s.`,
      true,
      cooldown.remainingSeconds
    );
  }

  const burnedInfo = burnedPinsStore.get(pin);
  if (burnedInfo) {
    return sendApiError(res, 410, "FILE_DELETED", "File has been deleted.", false);
  }

  let foundSession: StoredPayload | undefined;
  for (const [storedPin, item] of sessions.entries()) {
    if (timingSafeEqualStr(storedPin, pin)) {
      foundSession = item;
      break;
    }
  }

  if (!foundSession || foundSession.state !== "live") {
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
      "No active payload found for this PIN. It may have never existed, was already purged, or the server restarted.",
      false
    );
  }

  if (Date.now() >= foundSession.expiresAt) {
    burnSession(foundSession, "TTL expired");
    return sendApiError(res, 410, "FILE_DELETED", "File has expired and was deleted.", false);
  }

  const remainingMs = Math.max(0, foundSession.expiresAt - Date.now());

  let safeVerificationBlob: { ciphertext: string; iv: string } | undefined = undefined;
  if (foundSession.keyMode === "fragment" && foundSession.keyVerificationBlob) {
    safeVerificationBlob = foundSession.keyVerificationBlob;
  }

  return res.json({
    exists: true,
    pin: foundSession.pin,
    type: foundSession.type,
    fileMeta: foundSession.file ? {
      name: foundSession.file.name,
      size: foundSession.file.size,
      type: foundSession.file.type,
    } : undefined,
    shareMode: foundSession.shareMode,
    readCount: foundSession.completed,
    maxReads: foundSession.maxReads,
    inFlightCount: foundSession.inFlight.size,
    expiresAt: foundSession.expiresAt,
    remainingMs,
    bootId: BOOT_ID,
    isEncrypted: !!foundSession.encryptedBundle?.isEncrypted,
    keyMode: foundSession.keyMode,
    verificationBlob: safeVerificationBlob,
  });
};

router.get("/check/:pin", handleCheckPin);

// Pickup endpoint
const handlePickup = (req: Request, res: Response) => {
  const ip = getClientIp(req);

  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("Accept-Ranges", "none");
  res.setHeader("Content-Encoding", "identity");

  if (req.headers["range"]) {
    return sendApiError(
      res,
      416,
      "RANGE_NOT_SATISFIABLE",
      "Range requests are strictly disallowed for ephemeral, zero-persistence RAM streams.",
      false
    );
  }

  const lockout = isIpPickupLockedOut(ip);
  if (lockout.isLocked) {
    return sendApiError(
      res,
      429,
      "LOCKED_OUT",
      `Too many failed PIN attempts. IP temporarily locked for ${lockout.remainingLockSeconds} seconds.`,
      true,
      lockout.remainingLockSeconds
    );
  }

  const { pin } = req.body || {};
  if (!pin || !/^[0-9]{4}$/.test(pin)) {
    return sendApiError(res, 400, "INVALID_PIN_FORMAT", "PIN must be exactly 4 numeric digits.", false);
  }

  const cooldown = isPinInCooldown(pin);
  if (cooldown.inCooldown) {
    return sendApiError(
      res,
      429,
      "PIN_COOLDOWN",
      `PIN is temporarily in cooldown. Please retry in ${cooldown.remainingSeconds}s.`,
      true,
      cooldown.remainingSeconds
    );
  }

  const burnedInfo = burnedPinsStore.get(pin);
  if (burnedInfo) {
    return sendApiError(res, 410, "FILE_DELETED", "File has been deleted.", false);
  }

  let session: StoredPayload | undefined;
  for (const [storedPin, item] of sessions.entries()) {
    if (timingSafeEqualStr(storedPin, pin)) {
      session = item;
      break;
    }
  }

  if (!session || session.state !== "live") {
    const attempt = recordFailedPickupAttempt(ip, pin);
    if (attempt.isLocked) {
      return sendApiError(
        res,
        429,
        "LOCKED_OUT",
        `Too many failed pickup attempts. IP locked for ${attempt.remainingLockSeconds}s.`,
        true,
        attempt.remainingLockSeconds
      );
    }
    return sendApiError(res, 404, "PIN_NOT_FOUND", "No active file found for this PIN.", false);
  }

  if (Date.now() >= session.expiresAt) {
    burnSession(session, "TTL expired");
    return sendApiError(res, 410, "FILE_DELETED", "File has expired and was deleted.", false);
  }

  const reservation = reserveSlot(session, res);
  if (reservation === "GONE") {
    return sendApiError(res, 410, "FILE_DELETED", "File has been deleted.", false);
  }

  if (reservation === "FULL") {
    return sendApiError(
      res,
      409,
      "SLOTS_BUSY",
      "All download slots are currently occupied by active recipients. Retrying automatically.",
      true,
      3
    );
  }

  clearPickupFailedAttempts(ip);

  const reservationId = reservation;
  let isFinalized = false;

  const simulateMs = parseInt(req.headers["x-simulate-download-ms"] as string, 10);
  if (!isNaN(simulateMs) && simulateMs > 0) {
    const simulateTimer = setTimeout(() => {
      if (!isFinalized) {
        isFinalized = true;
        commitSlot(session, reservationId);
        res.json({
          success: true,
          simulated: true,
          pin: session.pin,
          readCount: session.completed,
          maxReads: session.maxReads,
          isBurned: session.maxReads !== null && session.completed >= session.maxReads,
        });
      }
    }, simulateMs);

    res.on("close", () => {
      if (!isFinalized && !res.writableEnded) {
        clearTimeout(simulateTimer);
        isFinalized = true;
        releaseSlot(session, reservationId);
      }
    });
    return;
  }

  res.on("close", () => {
    if (!isFinalized && !res.writableEnded) {
      isFinalized = true;
      releaseSlot(session, reservationId);
    }
  });

  isFinalized = true;
  commitSlot(session, reservationId);

  return res.json({
    success: true,
    pin: session.pin,
    payload: {
      type: session.type,
      textContent: session.textContent,
      file: session.file,
      encryptedBundle: session.encryptedBundle,
      shareMode: session.shareMode,
      keyMode: session.keyMode,
    },
    bootId: BOOT_ID,
    readCount: session.completed,
    maxReads: session.maxReads,
    isBurned: session.maxReads !== null && session.completed >= session.maxReads,
  });
};

router.post("/pickup", handlePickup);
router.all("/pickup", (_req: Request, res: Response) => {
  res.setHeader("Allow", "POST");
  return sendApiError(res, 405, "METHOD_NOT_ALLOWED", "Pickup requires POST method.", false);
});

// Manual burn
router.post("/burn", (req: Request, res: Response) => {
  const { pin, senderToken } = req.body;
  const tokenHeader = req.headers["x-sender-token"] as string | undefined;
  const activeToken = senderToken || tokenHeader;

  if (!pin || !activeToken) {
    return sendApiError(res, 400, "INVALID_REQUEST", "PIN and senderToken are required.", false);
  }

  let session: StoredPayload | undefined;
  for (const [storedPin, item] of sessions.entries()) {
    if (timingSafeEqualStr(storedPin, pin)) {
      session = item;
      break;
    }
  }

  if (!session) {
    const burnedInfo = burnedPinsStore.get(pin);
    if (burnedInfo) {
      return res.json({ success: true, message: "File has already been incinerated." });
    }
    return sendApiError(res, 404, "PIN_NOT_FOUND", "Session not found.", false);
  }

  if (!timingSafeEqualStr(session.senderToken, activeToken)) {
    return sendApiError(res, 403, "FORBIDDEN", "Invalid sender token. Only the sender can burn the drop.", false);
  }

  burnSession(session, "Manual burn by sender");
  return res.json({ success: true, message: "File has been deleted." });
});

// Real-time SSE Events
router.get("/events/:pin", (req: Request, res: Response) => {
  const pin = req.params.pin;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.setHeader("Content-Encoding", "identity");

  if (res.flushHeaders) {
    res.flushHeaders();
  }

  const burnedInfo = burnedPinsStore.get(pin);
  if (burnedInfo) {
    res.write(`data: ${JSON.stringify({ type: "burned", isBurned: true, message: "File has been deleted.", bootId: BOOT_ID })}\n\n`);
    return res.end();
  }

  let session: StoredPayload | undefined;
  for (const [storedPin, item] of sessions.entries()) {
    if (timingSafeEqualStr(storedPin, pin)) {
      session = item;
      break;
    }
  }

  const remainingMs = session ? Math.max(0, session.expiresAt - Date.now()) : 0;
  res.write(`data: ${JSON.stringify({
    type: "snapshot",
    pin: maskPin(pin),
    state: session?.state,
    bootId: BOOT_ID,
    readCount: session?.completed || 0,
    maxReads: session?.maxReads,
    inFlightCount: session?.inFlight.size || 0,
    remainingMs,
    timestamp: Date.now(),
  })}\n\n`);

  if (!sseClients.has(pin)) {
    sseClients.set(pin, new Set());
  }
  sseClients.get(pin)!.add(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(": keepalive\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    const clients = sseClients.get(pin);
    if (clients) {
      clients.delete(res);
      if (clients.size === 0) {
        sseClients.delete(pin);
      }
    }
  });
});

// Mount router on both /api and root
apiApp.use("/api", router);
apiApp.use(router);

// Unknown /api/* route handler (Must return JSON 404, never index.html!)
apiApp.all("/api/*", (_req: Request, res: Response) => {
  return sendApiError(res, 404, "NOT_FOUND", "API route not found.", false);
});

export default apiApp;
