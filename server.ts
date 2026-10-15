import express, { Request, Response, NextFunction } from "express";
import path from "path";
import crypto from "crypto";
import { createServer as createViteServer } from "vite";

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
const MAX_SINGLE_PAYLOAD_BYTES = 55 * 1024 * 1024;     // 55 MB max per request (accommodates 50MB file + base64 + E2E tag/IV)
const LEASE_MS = 35000;                               // 35s in-flight lease for download streaming
const STAGED_MAX_AGE_MS = 120000;                     // 2 min max age for reserved/staged sessions before reaper
const FORCE_DRAIN_GRACE_MS = 45000;                   // 45s grace period for closed sessions before forced drain

let currentTotalRamBytes = 0;
const ipActiveRamBytes = new Map<string, number>();
const ipActiveSessions = new Map<string, number>();

// Ephemeral in-memory store
const sessions = new Map<string, StoredPayload>();
const burnedPinsStore = new Map<string, { burnedAt: number; reason: string }>();

// SSE Subscriptions for real-time pickup and deletion notifications
const sseClients = new Map<string, Set<Response>>();

// Rate limiting & Brute-force lockout state
interface RateLimitRecord {
  failedAttempts: number;
  lockedUntil: number;
  lastAttempt: number;
}
const ipPickupRateLimits = new Map<string, RateLimitRecord>();
const ipCheckRateLimits = new Map<string, RateLimitRecord>();

// Per-PIN attempt tracking: triggers cooldown + sender alert (DOES NOT auto-incinerate live drops)
interface PinCooldownRecord {
  failedAttempts: number;
  cooldownUntil: number;
  lastAttempt: number;
}
const pinCooldowns = new Map<string, PinCooldownRecord>();
const PIN_COOLDOWN_FAILED_THRESHOLD = 5; // 5 failed attempts on a PIN triggers cooldown
const PIN_COOLDOWN_DURATION_MS = 60 * 1000; // 60 seconds cooldown window

const MAX_PICKUP_FAILED_ATTEMPTS = 5;
const MAX_CHECK_FAILED_ATTEMPTS = 25; // Generous budget for preview checks / bots
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

// Standardized API error envelopes
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
    errorCode: code,
    bootId: BOOT_ID,
  });
}

function sanitizeFilename(name: string): string {
  if (!name) return "unnamed-file";
  // Remove control chars, null bytes, RTL override characters, and path traversals
  const sanitized = name
    .replace(/[\x00-\x1F\x7F\u200E\u200F\u202A-\u202E]/g, "")
    .replace(/[/\\]/g, "_")
    .replace(/\.\./g, "_")
    .trim()
    .slice(0, 255);
  return sanitized.length > 0 ? sanitized : "sanitized-file";
}

// Normalize IP address (normalizes IPv6 to /64 subnet prefix and strips IPv4-mapped IPv6)
function normalizeIp(rawIp: string): string {
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
function getClientIp(req: Request): string {
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
function recordFailedPickupAttempt(
  ip: string,
  pin: string
): { isLocked: boolean; remainingLockSeconds: number; attempts: number; isPinCoolingDown: boolean; remainingCooldownSeconds: number } {
  const now = Date.now();

  // 1. Track PIN-level attempts across all IPs: triggers cooldown + sender alert (NOT auto-incinerate!)
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

    // Send SSE security alert to the sender
    broadcastSseEvent(pin, {
      type: "security_alert",
      warning: "PIN_COOLDOWN_ACTIVATED",
      message: `Security Notice: Multiple failed PIN attempts detected for code ${maskPin(pin)}. PIN is in a 60-second cooldown to block brute-force attempts.`,
      cooldownSeconds: 60,
      timestamp: now,
    });
  }
  pinCooldowns.set(pin, pinRec);

  // 2. Track per-IP pickup attempts
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
function recordFailedCheckAttempt(ip: string, pin: string): { isLocked: boolean; remainingLockSeconds: number; attempts: number } {
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

function isPinInCooldown(pin: string): { inCooldown: boolean; remainingSeconds: number } {
  const now = Date.now();
  const rec = pinCooldowns.get(pin);
  if (rec && rec.cooldownUntil > now) {
    return { inCooldown: true, remainingSeconds: Math.ceil((rec.cooldownUntil - now) / 1000) };
  }
  return { inCooldown: false, remainingSeconds: 0 };
}

function clearPickupFailedAttempts(ip: string) {
  ipPickupRateLimits.delete(ip);
}

function isIpPickupLockedOut(ip: string): { isLocked: boolean; remainingLockSeconds: number } {
  const now = Date.now();
  const record = ipPickupRateLimits.get(ip);
  if (!record) return { isLocked: false, remainingLockSeconds: 0 };
  if (record.lockedUntil > now) {
    return { isLocked: true, remainingLockSeconds: Math.ceil((record.lockedUntil - now) / 1000) };
  }
  return { isLocked: false, remainingLockSeconds: 0 };
}

function isIpCheckLockedOut(ip: string): { isLocked: boolean; remainingLockSeconds: number } {
  const now = Date.now();
  const record = ipCheckRateLimits.get(ip);
  if (!record) return { isLocked: false, remainingLockSeconds: 0 };
  if (record.lockedUntil > now) {
    return { isLocked: true, remainingLockSeconds: Math.ceil((record.lockedUntil - now) / 1000) };
  }
  return { isLocked: false, remainingLockSeconds: 0 };
}

// Broadcast SSE event to active connections for a PIN
function broadcastSseEvent(pin: string, eventData: object) {
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

// -------------------------------------------------------------
// CONCURRENCY & LEASE RESERVATION ENGINE (Fix B)
// -------------------------------------------------------------

function reserveSlot(s: StoredPayload, res?: Response, now = Date.now()): string | "FULL" | "GONE" {
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

function commitSlot(s: StoredPayload, reservationId: string) {
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

function releaseSlot(s: StoredPayload, reservationId: string) {
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
function drainCheck(s: StoredPayload) {
  if (s.state !== "closed") return;
  if (s.inFlight.size > 0) return; // In-flight pickups are still downloading safely from buffer!
  if (s.isWiped) return;
  s.isWiped = true;

  // Zero-fill and clean payload references
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

  // Close SSE connections after a short grace period
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

// Idempotent burn function
function burnSession(s: StoredPayload, reason = "incinerated") {
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

// Allocate a fresh, non-colliding 4-digit PIN in a single synchronous tick
function allocateSession(creatorIp: string, requestedTtlSeconds = 600, customPin?: string): StoredPayload {
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

// Periodic background sweeper (runs every 5 seconds)
setInterval(() => {
  const now = Date.now();

  for (const [pin, s] of sessions.entries()) {
    // 1. Expire stale in-flight leases (skip active streaming responses!)
    for (const [resId, lease] of s.inFlight.entries()) {
      const isResOpen = lease.res && !lease.res.writableEnded && !lease.res.destroyed;
      if (isResOpen) {
        // Active stream: extend lease so sweeper never releases while download bytes flow
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

    // 2. Reaper for abandoned 'reserved' or 'staged' sessions that never finalize
    if ((s.state === "reserved" || s.state === "staged") && now - s.stagedAt > STAGED_MAX_AGE_MS) {
      sessions.delete(pin);
      continue;
    }

    // 3. Lazy expiry for live sessions
    if (s.state === "live" && now >= s.expiresAt) {
      burnSession(s, "TTL expired");
      continue;
    }

    // 4. Force drain for closed sessions that have exceeded the safety grace period
    if (s.state === "closed" && !s.isWiped && s.burnedAt && now - s.burnedAt > FORCE_DRAIN_GRACE_MS) {
      s.inFlight.clear();
      drainCheck(s);
    }
  }

  // Cleanup rate-limit records older than 15 mins
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
  // Cleanup burned pins records older than 1 hour
  for (const [pin, rec] of burnedPinsStore.entries()) {
    if (now - rec.burnedAt > 60 * 60 * 1000) {
      burnedPinsStore.delete(pin);
    }
  }

  // Periodic memory reconciliation to eliminate any accounting drift
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

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Configurable reverse proxy trust (default 1 hop; supports CDN + platform proxy when TRUST_PROXY=2)
  const trustProxyEnv = process.env.TRUST_PROXY;
  if (trustProxyEnv) {
    const num = parseInt(trustProxyEnv, 10);
    app.set("trust proxy", isNaN(num) ? trustProxyEnv : num);
  } else {
    app.set("trust proxy", 1);
  }

  // Cross-Origin Resource Sharing (CORS) for static frontend deployments
  app.use((req: Request, res: Response, next: NextFunction) => {
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

  // 1. Tag all responses with BOOT_ID
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("X-Boot-Id", BOOT_ID);
    next();
  });

  // 2. Enterprise Security Headers Middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
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

  // 3. Size limit check & dynamic streaming byte counter before body parsing
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === "POST" && (req.path === "/api/drop" || req.path === "/api/download-stream")) {
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

      // Count streamed bytes dynamically to never trust Content-Length alone
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

      const cleanup = () => clearTimeout(idleTimeout);
      req.on("end", cleanup);
      req.on("close", cleanup);
    }
    next();
  });

  // 4. JSON & URL-Encoded body parser (limit 55mb for base64 / E2E overhead)
  app.use(express.json({ limit: "55mb" }));
  app.use(express.urlencoded({ extended: true, limit: "55mb" }));

  // Body parser error handler to ensure JSON 413 / 400 responses
  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
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

  // 5. CSRF Protection for state-mutating POST requests
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method === "POST" && req.path.startsWith("/api/")) {
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

  // --- API ROUTES ---

  // Health check
  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({
      status: "online",
      bootId: BOOT_ID,
      activeSessions: sessions.size,
      currentRamMb: (currentTotalRamBytes / (1024 * 1024)).toFixed(2),
      maxRamMb: (MAX_TOTAL_RAM_BYTES / (1024 * 1024)).toFixed(0),
      system: "Zero-Persistence / RAM-Only Buffer",
    });
  });

  // Check PIN availability for custom PINs
  app.get("/api/session/check-pin/:pin", (req: Request, res: Response) => {
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

  // Allocate fresh session PIN (state: 'reserved')
  app.get("/api/session", (req: Request, res: Response) => {
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
  app.post("/api/session/stage", (req: Request, res: Response) => {
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

  // Finalize / Drop Payload (Transitions session to 'live')
  app.post("/api/drop", (req: Request, res: Response) => {
    const ip = getClientIp(req);
    const {
      pin,
      senderToken: providedSenderToken,
      idempotencyKey,
      type,
      textContent,
      file,
      encryptedBundle,
      keyVerificationBlob,
      keyMode,
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

    // Check if session exists
    let session = sessions.get(pin);

    // If session was not pre-allocated, allocate it now
    if (!session) {
      session = allocateSession(ip, requestedTtl || 600, pin);
    }

    // Strict ownership verification
    if (session.senderToken && providedSenderToken && !timingSafeEqualStr(session.senderToken, providedSenderToken)) {
      return sendApiError(res, 403, "UNAUTHORIZED_TOKEN", "Forbidden: Invalid sender token.", false);
    }

    // Idempotency check: prevent duplicate submissions or StrictMode re-runs
    if (idempotencyKey && session.idempotencyKey === idempotencyKey && session.state === "live") {
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

    // Per-IP session cap check
    const currentIpSessions = ipActiveSessions.get(ip) || 0;
    if (session.state !== "live" && currentIpSessions >= MAX_ACTIVE_DROPS_PER_IP) {
      return sendApiError(
        res,
        429,
        "SESSION_CAP_EXCEEDED",
        `Client session cap reached (maximum ${MAX_ACTIVE_DROPS_PER_IP} concurrent active drops per IP).`,
        true,
        60
      );
    }

    // Estimate payload size in bytes
    let estimatedBytes = 1024;
    if (type === "text") {
      if (encryptedBundle?.ciphertext) {
        estimatedBytes += encryptedBundle.ciphertext.length * 2;
      } else if (textContent) {
        if (textContent.trim().length === 0) {
          return sendApiError(res, 400, "EMPTY_PAYLOAD", "Text payload cannot be empty.", false);
        }
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

    // Check Per-IP RAM Quota (150 MB)
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

    // Sanitize filename & metadata
    let sanitizedFile = file;
    if (file && file.name) {
      sanitizedFile = {
        name: sanitizeFilename(file.name),
        size: typeof file.size === "number" && file.size > 0 ? file.size : 0,
        type: file.type || "application/octet-stream",
        dataUrl: file.dataUrl,
      };
    }

    const rawTtl = Number(requestedTtl);
    const ttlSeconds = !isNaN(rawTtl) && rawTtl > 0 ? Math.min(3600, Math.max(1, rawTtl)) : session.ttlSeconds || 600;
    const now = Date.now();
    const expiresAt = now + ttlSeconds * 1000;

    const parsedMaxReads = Number(maxReads);
    const validMaxReads = !isNaN(parsedMaxReads) && parsedMaxReads > 0 ? Math.floor(parsedMaxReads) : (shareMode === "multiple_reads" ? null : 1);

    // Update session state to LIVE
    session.state = "live";
    session.idempotencyKey = idempotencyKey;
    session.creatorIp = ip;
    session.type = type;
    session.shareMode = shareMode === "multiple_reads" ? "multiple_reads" : "burn_on_read";
    session.maxReads = validMaxReads;
    session.sizeBytes = estimatedBytes;
    session.textContent = type === "text" && !encryptedBundle ? textContent : undefined;
    session.file = type === "file" ? sanitizedFile : undefined;
    session.encryptedBundle = encryptedBundle?.isEncrypted ? encryptedBundle : undefined;
    session.keyVerificationBlob = keyVerificationBlob;
    session.keyMode = keyMode === "fragment" ? "fragment" : "pin";
    session.createdAt = now;
    session.expiresAt = expiresAt;
    session.ttlSeconds = ttlSeconds;

    currentTotalRamBytes += estimatedBytes;
    ipActiveRamBytes.set(ip, (ipActiveRamBytes.get(ip) || 0) + estimatedBytes);
    ipActiveSessions.set(ip, (ipActiveSessions.get(ip) || 0) + 1);

    const remainingMs = Math.max(0, expiresAt - now);

    // Notify connected SSE observers
    broadcastSseEvent(pin, {
      type: "live",
      pin,
      remainingMs,
      shareMode: session.shareMode,
      maxReads: session.maxReads,
    });

    console.log(`[Burner Room] File published & LIVE: Code ${maskPin(pin)} (${type}, mode: ${session.shareMode}, maxReads: ${session.maxReads ?? 'unlimited'})`);

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

  // Non-destructive check on PIN (Receivers ONLY see 'live' sessions; reserved/staged return 404)
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

    // Check if PIN is currently cooling down from excessive failed attempts
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

    // Check if previously burned/incinerated
    const burnedInfo = burnedPinsStore.get(pin);
    if (burnedInfo) {
      return sendApiError(
        res,
        410,
        "FILE_DELETED",
        "File has been deleted.",
        false
      );
    }

    let foundSession: StoredPayload | undefined;
    for (const [storedPin, item] of sessions.entries()) {
      if (timingSafeEqualStr(storedPin, pin)) {
        foundSession = item;
        break;
      }
    }

    // Crucial: Only sessions in 'live' state are visible to receivers!
    // 'reserved' or 'staged' sessions return the exact same 404 as unknown PIN
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
        `No active payload found for PIN ${pin}.`,
        false
      );
    }

    // Check expiry lazily on every access
    const now = Date.now();
    if (foundSession.expiresAt <= now) {
      burnSession(foundSession, "TTL expired");
      return sendApiError(
        res,
        410,
        "FILE_DELETED",
        "Payload has expired and was automatically incinerated.",
        false
      );
    }

    const remainingMs = Math.max(0, foundSession.expiresAt - now);

    return res.json({
      exists: true,
      state: foundSession.state,
      bootId: BOOT_ID,
      type: foundSession.type,
      shareMode: foundSession.shareMode,
      readCount: foundSession.completed,
      inFlightCount: foundSession.inFlight.size,
      maxReads: foundSession.maxReads,
      remainingMs,
      remainingSeconds: Math.floor(remainingMs / 1000),
      expiresAt: foundSession.expiresAt,
      keyMode: foundSession.keyMode,
      // CRITICAL: Only expose verificationBlob in 'fragment' keyMode!
      // In 'pin' mode, exposing verificationBlob would allow attackers to brute-force the 4-digit PIN offline!
      verificationBlob: foundSession.keyMode === "fragment" ? foundSession.keyVerificationBlob : undefined,
      fileMeta: foundSession.file
        ? { name: foundSession.file.name, size: foundSession.file.size, type: foundSession.file.type }
        : undefined,
      isEncrypted: !!foundSession.encryptedBundle,
    });
  };

  app.get("/api/check/:pin", handleCheckPin);
  app.head("/api/check/:pin", handleCheckPin);

  // Method guard for /api/pickup (POST only)
  app.all("/api/pickup", (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== "POST") {
      return sendApiError(res, 405, "METHOD_NOT_ALLOWED", "Pickup endpoint accepts POST requests only.", false);
    }
    next();
  });

  // Explicit Human Pickup (POST with no-store; slot reservation model)
  app.post("/api/pickup", (req: Request, res: Response) => {
    // Disable caching, disable compression, and reject Range requests
    res.setHeader("Accept-Ranges", "none");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Content-Encoding", "identity");

    if (req.headers.range) {
      return sendApiError(res, 416, "RANGE_NOT_SATISFIABLE", "Range requests are not supported.", false);
    }

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

    // Check if PIN is in temporary cooldown
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

    // Check if burned
    const burnedInfo = burnedPinsStore.get(pin);
    if (burnedInfo) {
      return sendApiError(
        res,
        410,
        "FILE_DELETED",
        "File has been deleted.",
        false
      );
    }

    let session: StoredPayload | undefined;
    for (const [storedPin, val] of sessions.entries()) {
      if (timingSafeEqualStr(storedPin, pin)) {
        session = val;
        break;
      }
    }

    // Only 'live' sessions are accessible for pickup
    if (!session || session.state !== "live") {
      const attempt = recordFailedPickupAttempt(ip, pin);
      if (attempt.isPinCoolingDown) {
        return sendApiError(
          res,
          429,
          "PIN_COOLDOWN",
          `Too many failed attempts on this PIN. Cooldown active for ${attempt.remainingCooldownSeconds} seconds.`,
          true,
          attempt.remainingCooldownSeconds
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

    // Lazy expiry check on every access
    const now = Date.now();
    if (session.expiresAt <= now) {
      burnSession(session, "TTL expired");
      return sendApiError(
        res,
        410,
        "FILE_DELETED",
        "Session expired. Payload was automatically incinerated.",
        false
      );
    }

    // Clear IP failure counters on reaching an active session
    clearPickupFailedAttempts(ip);

    // Reserve an in-flight slot (Synchronous check & lease reservation attached to this response stream)
    const reservation = reserveSlot(session, res, now);
    if (reservation === "GONE") {
      return sendApiError(res, 410, "FILE_DELETED", "File has been deleted.", false);
    }
    if (reservation === "FULL") {
      // 409 SLOTS_BUSY NEVER increments failed attempt counter or locks out user
      return sendApiError(
        res,
        409,
        "SLOTS_BUSY",
        "All download slots are currently in use. Another recipient is downloading. Please retry in a few seconds.",
        true,
        3
      );
    }

    // Register stream delivery lifecycle hooks
    let finished = false;
    res.on("finish", () => {
      finished = true;
      commitSlot(session!, reservation);
    });
    res.on("close", () => {
      if (!finished) {
        releaseSlot(session!, reservation);
      }
    });

    const isLastRead = session.maxReads !== null && (session.completed + 1) >= session.maxReads;

    const responsePayload = JSON.stringify({
      success: true,
      bootId: BOOT_ID,
      isBurned: isLastRead,
      shareMode: session.shareMode,
      readCount: session.completed + 1,
      maxReads: session.maxReads,
      payload: {
        pin: session.pin,
        type: session.type,
        shareMode: session.shareMode,
        readCount: session.completed + 1,
        maxReads: session.maxReads,
        textContent: session.textContent,
        file: session.file,
        encryptedBundle: session.encryptedBundle,
        keyVerificationBlob: session.keyVerificationBlob,
        keyMode: session.keyMode,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        ttlSeconds: session.ttlSeconds,
        status: isLastRead ? "retrieved" : "pending",
      },
    });

    const responseBuf = Buffer.from(responsePayload, "utf-8");
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Content-Length", responseBuf.length);

    // Stream response chunks respecting socket backpressure and in-flight lease duration
    const simulateMs = parseInt(req.headers["x-simulate-download-ms"] as string, 10);
    const CHUNK_SIZE = 64 * 1024;
    let offset = 0;

    function pushNextChunk() {
      if (finished || res.destroyed) return;
      if (offset >= responseBuf.length) {
        if (!isNaN(simulateMs) && simulateMs > 0) {
          setTimeout(() => {
            if (!finished && !res.destroyed) {
              res.end();
            }
          }, simulateMs);
        } else {
          res.end();
        }
        return;
      }

      const nextOffset = Math.min(offset + CHUNK_SIZE, responseBuf.length);
      const chunk = responseBuf.subarray(offset, nextOffset);
      offset = nextOffset;

      if (res.write(chunk)) {
        setImmediate(pushNextChunk);
      } else {
        res.once("drain", pushNextChunk);
      }
    }

    pushNextChunk();
  });

  // Direct Binary Streaming Download Route
  app.post("/api/download-stream", (req: Request, res: Response) => {
    try {
      const { dataUrl, fileName, mimeType } = req.body;
      if (!dataUrl || typeof dataUrl !== "string") {
        return sendApiError(res, 400, "MISSING_DATA", "No file data provided for download stream.", false);
      }

      const safeName = sanitizeFilename(fileName || "burner-download");
      let base64Content = dataUrl;
      let detectedMime = mimeType || "application/octet-stream";

      if (dataUrl.startsWith("data:")) {
        const commaIdx = dataUrl.indexOf(",");
        if (commaIdx !== -1) {
          const header = dataUrl.slice(0, commaIdx);
          base64Content = dataUrl.slice(commaIdx + 1);
          const match = header.match(/data:([^;]+)/);
          if (match && match[1]) {
            detectedMime = match[1].trim();
          }
        }
      }

      const cleanBase64 = base64Content.replace(/[\s\r\n]+/g, "");
      const buffer = Buffer.from(cleanBase64, "base64");

      if (buffer.length === 0) {
        return sendApiError(res, 400, "EMPTY_BUFFER", "Decoded file content is empty (0 bytes).", false);
      }

      res.setHeader("Content-Type", detectedMime);
      res.setHeader("Content-Length", buffer.length);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${encodeURIComponent(safeName)}"; filename*=UTF-8''${encodeURIComponent(safeName)}`
      );
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
      res.setHeader("Pragma", "no-cache");
      return res.send(buffer);
    } catch (err: any) {
      console.error("[Burner Room] Download stream error:", err);
      return sendApiError(res, 500, "STREAM_FAILED", "Failed to stream download file.", false);
    }
  });

  // Manual Burn with cryptographic senderToken verification
  app.post("/api/burn", (req: Request, res: Response) => {
    const { pin, senderToken } = req.body;
    const headerToken = req.headers["x-sender-token"] as string | undefined;
    const activeToken = senderToken || headerToken;

    if (!pin) {
      return sendApiError(res, 400, "INVALID_PIN_FORMAT", "PIN is required.", false);
    }

    const session = sessions.get(pin);
    if (!session) {
      return res.json({ success: true, message: "Session already cleared from memory.", bootId: BOOT_ID });
    }

    if (!activeToken || !timingSafeEqualStr(session.senderToken, activeToken)) {
      return sendApiError(
        res,
        403,
        "UNAUTHORIZED_TOKEN",
        "Forbidden: Invalid or missing sender ownership token.",
        false
      );
    }

    burnSession(session, "Manually incinerated by sender");
    console.log(`[Burner Room] PIN ${maskPin(pin)} manually incinerated by authorized sender.`);

    return res.json({ success: true, message: "Payload destroyed immediately.", bootId: BOOT_ID });
  });

  // Server-Sent Events (SSE) stream (Observer-only; drop never cancels session)
  app.get("/api/events/:pin", (req: Request, res: Response) => {
    const pin = req.params.pin;

    const session = sessions.get(pin);
    const burnedInfo = burnedPinsStore.get(pin);

    if (!session && !burnedInfo) {
      return res.status(404).json({ error: "Session not found.", bootId: BOOT_ID });
    }

    // Required SSE headers to prevent proxy buffering and compression
    res.setHeader("Content-Encoding", "identity");
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Content-Encoding": "identity",
    });

    if (res.flushHeaders) {
      res.flushHeaders();
    }

    if (burnedInfo) {
      res.write(`data: ${JSON.stringify({ type: "burned", isBurned: true, message: "File has been deleted.", bootId: BOOT_ID })}\n\n`);
      return res.end();
    }

    // Send full state snapshot on connect
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

    // 15s Keepalive heartbeat per specification
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

  // Catch-all for unknown /api/* routes: MUST return JSON 404, never index.html!
  app.all("/api/*", (_req: Request, res: Response) => {
    return sendApiError(res, 404, "NOT_FOUND", "API route not found.", false);
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

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Burner Room server running on port ${PORT} [Boot ID: ${BOOT_ID}]`);
  });

  // Precise Node.js server timeouts per specification
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.requestTimeout = 300000;
}

startServer();
