import express, { Request, Response, NextFunction } from "express";
import crypto from "crypto";

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

// Memory and Quota limits
const MAX_TOTAL_RAM_BYTES = 1.5 * 1024 * 1024 * 1024;
const MAX_RAM_BYTES_PER_IP = 150 * 1024 * 1024;
const MAX_ACTIVE_DROPS_PER_IP = 3;
const MAX_SINGLE_PAYLOAD_BYTES = 55 * 1024 * 1024;

// Global persistent state across serverless invocations
const globalStore = (globalThis as any).__burnerPayloadStore || new Map<string, StoredPayload>();
(globalThis as any).__burnerPayloadStore = globalStore;
const payloadStore: Map<string, StoredPayload> = globalStore;

const globalBurned = (globalThis as any).__burnerBurnedStore || new Map<string, { burnedAt: number; reason: string }>();
(globalThis as any).__burnerBurnedStore = globalBurned;
const burnedPinsStore: Map<string, { burnedAt: number; reason: string }> = globalBurned;

const globalIpPickupRate = (globalThis as any).__burnerIpPickupRate || new Map<string, { failedAttempts: number; lockedUntil: number; lastAttempt: number }>();
(globalThis as any).__burnerIpPickupRate = globalIpPickupRate;
const ipPickupRateLimits: Map<string, { failedAttempts: number; lockedUntil: number; lastAttempt: number }> = globalIpPickupRate;

const globalIpCheckRate = (globalThis as any).__burnerIpCheckRate || new Map<string, { failedAttempts: number; lockedUntil: number; lastAttempt: number }>();
(globalThis as any).__burnerIpCheckRate = globalIpCheckRate;
const ipCheckRateLimits: Map<string, { failedAttempts: number; lockedUntil: number; lastAttempt: number }> = globalIpCheckRate;

const globalPinAttempts = (globalThis as any).__burnerPinAttempts || new Map<string, number>();
(globalThis as any).__burnerPinAttempts = globalPinAttempts;
const pinGlobalFailedAttempts: Map<string, number> = globalPinAttempts;

const globalIpRam = (globalThis as any).__burnerIpRam || new Map<string, number>();
(globalThis as any).__burnerIpRam = globalIpRam;
const ipActiveRamBytes: Map<string, number> = globalIpRam;

const globalIpSessions = (globalThis as any).__burnerIpSessions || new Map<string, number>();
(globalThis as any).__burnerIpSessions = globalIpSessions;
const ipActiveSessions: Map<string, number> = globalIpSessions;

let currentTotalRamBytes = (globalThis as any).__burnerTotalRam || 0;

const MAX_PICKUP_FAILED_ATTEMPTS = 5;
const MAX_CHECK_FAILED_ATTEMPTS = 25;
const GLOBAL_PIN_MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_DURATION_MS = 10 * 60 * 1000;

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

function sanitizeFilename(name: string): string {
  if (!name) return "unnamed-file";
  const sanitized = name
    .replace(/[\x00-\x1F\x7F]/g, "")
    .replace(/[/\\]/g, "_")
    .replace(/\.\./g, "_")
    .trim();
  return sanitized.length > 0 ? sanitized : "sanitized-file";
}

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function recordFailedPickupAttempt(ip: string, pin: string): { isLocked: boolean; remainingLockSeconds: number; attempts: number; isGloballyIncinerated: boolean } {
  const now = Date.now();
  const globalAttempts = (pinGlobalFailedAttempts.get(pin) || 0) + 1;
  pinGlobalFailedAttempts.set(pin, globalAttempts);

  let isGloballyIncinerated = false;
  if (globalAttempts >= GLOBAL_PIN_MAX_FAILED_ATTEMPTS) {
    isGloballyIncinerated = true;
    if (payloadStore.has(pin)) {
      deletePayloadItem(pin, "Global brute-force threshold exceeded (10 failed attempts across all IPs).");
    }
  }

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

function recordFailedCheckAttempt(ip: string, pin: string): { isLocked: boolean; remainingLockSeconds: number; attempts: number } {
  const now = Date.now();
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

function deletePayloadItem(pin: string, reason = "incinerated") {
  const item = payloadStore.get(pin);
  if (item) {
    currentTotalRamBytes = Math.max(0, currentTotalRamBytes - item.sizeBytes);
    (globalThis as any).__burnerTotalRam = currentTotalRamBytes;
    
    if (item.creatorIp) {
      const activeBytes = ipActiveRamBytes.get(item.creatorIp) || 0;
      ipActiveRamBytes.set(item.creatorIp, Math.max(0, activeBytes - item.sizeBytes));
      
      const activeSessions = ipActiveSessions.get(item.creatorIp) || 0;
      ipActiveSessions.set(item.creatorIp, Math.max(0, activeSessions - 1));
    }
    payloadStore.delete(pin);
    burnedPinsStore.set(pin, { burnedAt: Date.now(), reason });
  }
}

function generateUniquePin(): string {
  const now = Date.now();
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

const app = express();

// Security Headers
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

// Pre-buffering RAM check
app.use((req: Request, res: Response, next: NextFunction) => {
  if (req.method === "POST" && (req.path === "/api/drop" || req.path === "/drop")) {
    const contentLengthHeader = req.headers["content-length"];
    if (contentLengthHeader) {
      const contentLength = parseInt(contentLengthHeader, 10);
      if (!isNaN(contentLength)) {
        if (contentLength > MAX_SINGLE_PAYLOAD_BYTES) {
          return res.status(413).json({
            error: "Payload size exceeds maximum allowed 50MB ceiling.",
            errorCode: "PAYLOAD_TOO_LARGE",
          });
        }
        if (currentTotalRamBytes + contentLength > MAX_TOTAL_RAM_BYTES) {
          return res.status(507).json({
            error: "Server temporary RAM buffer is currently at full capacity. Please try again shortly.",
            errorCode: "BUFFER_FULL",
          });
        }
      }
    }
  }
  next();
});

app.use(express.json({ limit: "55mb" }));
app.use(express.urlencoded({ extended: true, limit: "55mb" }));

// CSRF check
app.use((req: Request, res: Response, next: NextFunction) => {
  const mutatingPaths = ["/api/drop", "/drop", "/api/pickup", "/pickup", "/api/burn", "/burn"];
  if (req.method === "POST" && mutatingPaths.includes(req.path)) {
    const clientHeader = req.headers["x-burner-client"];
    const requestedWith = req.headers["x-requested-with"];
    const secFetchSite = req.headers["sec-fetch-site"];

    if (secFetchSite === "cross-site") {
      return res.status(403).json({
        error: "Cross-Site Request Forgery blocked.",
        errorCode: "CSRF_BLOCKED",
      });
    }

    if (!clientHeader && !requestedWith) {
      return res.status(403).json({
        error: "CSRF verification failed: Missing required security header.",
        errorCode: "CSRF_HEADER_MISSING",
      });
    }
  }
  next();
});

// API Routes
app.get(["/api/health", "/health"], (_req: Request, res: Response) => {
  res.json({
    status: "online",
    activeSessions: payloadStore.size,
    currentRamMb: (currentTotalRamBytes / (1024 * 1024)).toFixed(2),
    maxRamMb: (MAX_TOTAL_RAM_BYTES / (1024 * 1024)).toFixed(0),
    system: "Zero-Persistence / RAM-Only Buffer",
  });
});

app.get(["/api/session", "/session"], (req: Request, res: Response) => {
  const pin = generateUniquePin();
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

app.post(["/api/drop", "/drop"], (req: Request, res: Response) => {
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

  if (!pin || typeof pin !== "string" || pin.length !== 4) {
    return res.status(400).json({ error: "Invalid 4-digit PIN provided.", errorCode: "INVALID_INPUT" });
  }

  if (type !== "text" && type !== "file") {
    return res.status(400).json({ error: "Invalid payload type.", errorCode: "INVALID_INPUT" });
  }

  const currentIpSessions = ipActiveSessions.get(ip) || 0;
  if (currentIpSessions >= MAX_ACTIVE_DROPS_PER_IP) {
    return res.status(429).json({
      error: `Client session cap reached (maximum ${MAX_ACTIVE_DROPS_PER_IP} concurrent active drops per IP).`,
      errorCode: "RATE_LIMITED",
    });
  }

  let estimatedBytes = 1024;
  if (type === "text") {
    if (encryptedBundle?.ciphertext) {
      estimatedBytes += encryptedBundle.ciphertext.length * 2;
    } else if (textContent) {
      estimatedBytes += Buffer.byteLength(textContent, "utf-8");
    } else {
      return res.status(400).json({ error: "Text payload cannot be empty.", errorCode: "INVALID_INPUT" });
    }
  } else if (type === "file") {
    if (encryptedBundle?.ciphertext) {
      estimatedBytes += encryptedBundle.ciphertext.length * 2;
    } else if (file?.dataUrl) {
      estimatedBytes += file.dataUrl.length * 2;
    } else {
      return res.status(400).json({ error: "File payload is incomplete.", errorCode: "INVALID_INPUT" });
    }
  }

  const currentIpBytes = ipActiveRamBytes.get(ip) || 0;
  if (currentIpBytes + estimatedBytes > MAX_RAM_BYTES_PER_IP) {
    return res.status(507).json({
      error: `Per-client RAM quota exceeded (150MB limit per IP).`,
      errorCode: "QUOTA_EXCEEDED",
    });
  }

  if (currentTotalRamBytes + estimatedBytes > MAX_TOTAL_RAM_BYTES) {
    return res.status(507).json({
      error: "Server temporary RAM buffer is currently at full capacity.",
      errorCode: "BUFFER_FULL",
    });
  }

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

  let storedFile = sanitizedFile;
  if (type === "file" && sanitizedFile) {
    storedFile = {
      name: sanitizeFilename(sanitizedFile.name || "file"),
      size: typeof sanitizedFile.size === "number" && sanitizedFile.size > 0 ? sanitizedFile.size : 0,
      type: sanitizedFile.type || "application/octet-stream",
      dataUrl: encryptedBundle?.isEncrypted ? undefined : sanitizedFile.dataUrl,
    };
  }

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
    file: type === "file" ? storedFile : undefined,
    encryptedBundle: encryptedBundle?.isEncrypted ? encryptedBundle : undefined,
    createdAt: now,
    expiresAt,
    ttlSeconds,
    status: "pending",
  };

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
  (globalThis as any).__burnerTotalRam = currentTotalRamBytes;
  ipActiveRamBytes.set(ip, (ipActiveRamBytes.get(ip) || 0) + estimatedBytes);

  return res.json({
    success: true,
    message: "Payload armed successfully.",
    pin,
    senderToken,
    shareMode: payload.shareMode,
    maxReads: validMaxReads,
    expiresAt,
    ttlSeconds,
  });
});

const handleCheckPin = (req: Request, res: Response) => {
  const ip = getClientIp(req);
  const lockout = isIpCheckLockedOut(ip);
  if (lockout.isLocked) {
    res.setHeader("Retry-After", lockout.remainingLockSeconds);
    return res.status(429).json({
      exists: false,
      error: `Too many preview requests. Locked for ${lockout.remainingLockSeconds}s.`,
      errorCode: "LOCKED_OUT",
      retryAfter: lockout.remainingLockSeconds,
    });
  }

  const pin = req.params.pin;
  const burnedInfo = burnedPinsStore.get(pin);
  if (burnedInfo) {
    return res.status(410).json({
      exists: false,
      error: `This payload was incinerated (${burnedInfo.reason}).`,
      errorCode: "EXPIRED",
    });
  }

  let foundItem: StoredPayload | undefined;
  for (const [storedPin, item] of payloadStore.entries()) {
    if (timingSafeEqualStr(storedPin, pin)) {
      foundItem = item;
      break;
    }
  }

  if (!foundItem) {
    const attempt = recordFailedCheckAttempt(ip, pin);
    if (attempt.isLocked) {
      res.setHeader("Retry-After", attempt.remainingLockSeconds);
      return res.status(429).json({
        exists: false,
        error: "Too many failed preview requests. Access locked.",
        errorCode: "LOCKED_OUT",
        retryAfter: attempt.remainingLockSeconds,
      });
    }
    return res.status(404).json({
      exists: false,
      error: `No active payload found for PIN ${pin}.`,
      errorCode: "NOT_FOUND",
    });
  }

  if (foundItem.expiresAt <= Date.now()) {
    deletePayloadItem(foundItem.pin, "TTL expired");
    return res.status(410).json({
      exists: false,
      error: "Payload has expired and was automatically incinerated.",
      errorCode: "EXPIRED",
    });
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

app.get(["/api/check/:pin", "/check/:pin"], handleCheckPin);
app.head(["/api/check/:pin", "/check/:pin"], handleCheckPin);

app.post(["/api/pickup", "/pickup"], (req: Request, res: Response) => {
  const ip = getClientIp(req);
  const lockout = isIpPickupLockedOut(ip);
  if (lockout.isLocked) {
    res.setHeader("Retry-After", lockout.remainingLockSeconds);
    return res.status(429).json({
      success: false,
      error: `Too many failed PIN pickup attempts. IP locked for ${lockout.remainingLockSeconds} seconds.`,
      errorCode: "LOCKED_OUT",
      retryAfter: lockout.remainingLockSeconds,
    });
  }

  const { pin } = req.body;
  if (!pin || typeof pin !== "string") {
    return res.status(400).json({ success: false, error: "4-digit PIN is required.", errorCode: "INVALID_INPUT" });
  }

  const burnedInfo = burnedPinsStore.get(pin);
  if (burnedInfo) {
    return res.status(410).json({
      success: false,
      error: `Payload is no longer available (${burnedInfo.reason}).`,
      errorCode: "EXPIRED",
    });
  }

  let foundKey: string | undefined;
  let item: StoredPayload | undefined;

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
      return res.status(410).json({
        success: false,
        error: "Security Alert: This PIN was automatically incinerated after exceeding the global 10-attempt threshold across distributed sources.",
        errorCode: "EXPIRED",
      });
    }
    if (attempt.isLocked) {
      res.setHeader("Retry-After", attempt.remainingLockSeconds);
      return res.status(429).json({
        success: false,
        error: "Too many failed attempts. Access locked for 10 minutes.",
        errorCode: "LOCKED_OUT",
        retryAfter: attempt.remainingLockSeconds,
      });
    }
    return res.status(404).json({
      success: false,
      error: `Payload not found or already burned. (${MAX_PICKUP_FAILED_ATTEMPTS - attempt.attempts} attempts remaining)`,
      errorCode: "NOT_FOUND",
    });
  }

  const now = Date.now();
  if (item.expiresAt <= now) {
    deletePayloadItem(foundKey, "TTL expired");
    return res.status(410).json({
      success: false,
      error: "Session expired. Payload was automatically incinerated.",
      errorCode: "EXPIRED",
    });
  }

  clearPickupFailedAttempts(ip);
  item.readCount += 1;
  let isBurned = false;

  if (item.shareMode === "burn_on_read" || (item.maxReads && item.readCount >= item.maxReads)) {
    isBurned = true;
    deletePayloadItem(foundKey, "Download limit reached");
  }

  if (item.file) {
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(item.file.name)}"`);
  }

  return res.json({
    success: true,
    isBurned,
    message: isBurned ? "File has been deleted." : undefined,
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

app.post(["/api/burn", "/burn"], (req: Request, res: Response) => {
  const { pin, senderToken } = req.body;
  const headerToken = req.headers["x-sender-token"] as string | undefined;
  const activeToken = senderToken || headerToken;

  if (!pin) {
    return res.status(400).json({ error: "PIN is required." });
  }

  const item = payloadStore.get(pin);
  if (!item) {
    return res.json({ success: true, message: "Session already cleared from memory." });
  }

  if (!activeToken || !timingSafeEqualStr(item.senderToken, activeToken)) {
    return res.status(403).json({
      success: false,
      error: "Forbidden: Invalid or missing sender ownership token.",
      errorCode: "UNAUTHORIZED",
    });
  }

  deletePayloadItem(pin, "Manually incinerated by sender");
  return res.json({ success: true, message: "Payload destroyed immediately." });
});

export default app;
