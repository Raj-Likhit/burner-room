import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";

interface StoredPayload {
  pin: string;
  type: "text" | "file";
  shareMode: "burn_on_read" | "multiple_reads";
  readCount: number;
  textContent?: string;
  file?: {
    name: string;
    size: number;
    type: string;
    dataUrl: string;
  };
  createdAt: number;
  expiresAt: number;
  ttlSeconds: number;
  status: "pending" | "retrieved" | "expired";
}

// In-memory ephemeral storage simulating Vercel KV / Redis with automatic TTL and burn-on-read
const payloadStore = new Map<string, StoredPayload>();

// Generate non-colliding 4-digit numeric PIN
function generateUniquePin(): string {
  const now = Date.now();
  // Cleanup expired items first
  for (const [pin, item] of payloadStore.entries()) {
    if (item.expiresAt <= now) {
      payloadStore.delete(pin);
    }
  }

  for (let attempt = 0; attempt < 100; attempt++) {
    const pin = Math.floor(1000 + Math.random() * 9000).toString();
    if (!payloadStore.has(pin)) {
      return pin;
    }
  }
  // Fallback random
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// Periodic cleanup every 15 seconds
setInterval(() => {
  const now = Date.now();
  for (const [pin, item] of payloadStore.entries()) {
    if (item.expiresAt <= now) {
      payloadStore.delete(pin);
    }
  }
}, 15000);

async function startServer() {
  const app = express();
  const PORT = 3000;

  // JSON Body parser (Support up to 50MB for file uploads)
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ extended: true, limit: "50mb" }));

  // --- API ROUTES ---

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({
      status: "online",
      activeSessions: payloadStore.size,
      system: "Zero-Persistence / Read-Once",
    });
  });

  // 1. Generate / reserve fresh session PIN
  app.get("/api/session", (req, res) => {
    const pin = generateUniquePin();
    const rawTtl = Number(req.query.ttl || req.query.ttlSeconds);
    const ttlSeconds = !isNaN(rawTtl) && rawTtl > 0 ? Math.min(3600, Math.max(60, rawTtl)) : 600; // 1 min to 60 mins (default 10m)
    const now = Date.now();
    const expiresAt = now + ttlSeconds * 1000;

    res.json({
      pin,
      createdAt: now,
      expiresAt,
      ttlSeconds,
    });
  });

  // 2. Upload / Drop Payload
  app.post("/api/drop", (req, res) => {
    const { pin, type, textContent, file, shareMode, ttlSeconds: requestedTtl } = req.body;

    if (!pin || typeof pin !== "string" || pin.length !== 4) {
      return res.status(400).json({ error: "Invalid 4-digit PIN provided." });
    }

    if (type !== "text" && type !== "file") {
      return res.status(400).json({ error: "Invalid payload type." });
    }

    if (type === "text" && (!textContent || typeof textContent !== "string" || textContent.trim() === "")) {
      return res.status(400).json({ error: "Text payload cannot be empty." });
    }

    if (type === "file" && (!file || !file.name || !file.dataUrl)) {
      return res.status(400).json({ error: "File payload is incomplete." });
    }

    const rawTtl = Number(requestedTtl);
    const ttlSeconds = !isNaN(rawTtl) && rawTtl > 0 ? Math.min(3600, Math.max(60, rawTtl)) : 600; // 1m - 60m
    const now = Date.now();
    const expiresAt = now + ttlSeconds * 1000;

    const payload: StoredPayload = {
      pin,
      type,
      shareMode: shareMode === "multiple_reads" ? "multiple_reads" : "burn_on_read",
      readCount: 0,
      textContent: type === "text" ? textContent : undefined,
      file: type === "file" ? file : undefined,
      createdAt: now,
      expiresAt,
      ttlSeconds,
      status: "pending",
    };

    payloadStore.set(pin, payload);

    console.log(`[Burner Room] Payload dropped for PIN: ${pin} (${type}, mode: ${payload.shareMode}, ttl: ${ttlSeconds}s).`);

    return res.json({
      success: true,
      message: "Payload uploaded successfully. Ready for pickup.",
      pin,
      shareMode: payload.shareMode,
      expiresAt,
      ttlSeconds,
    });
  });

  // 3. Check PIN status without consuming it (lightweight ping)
  app.get("/api/check/:pin", (req, res) => {
    const pin = req.params.pin;
    const item = payloadStore.get(pin);

    if (!item) {
      return res.status(404).json({ exists: false, message: "No active payload found for this PIN." });
    }

    if (item.expiresAt <= Date.now()) {
      payloadStore.delete(pin);
      return res.status(410).json({ exists: false, message: "Payload expired and was self-destructed." });
    }

    return res.json({
      exists: true,
      type: item.type,
      shareMode: item.shareMode,
      readCount: item.readCount,
      expiresAt: item.expiresAt,
      remainingSeconds: Math.max(0, Math.floor((item.expiresAt - Date.now()) / 1000)),
      fileMeta: item.file ? { name: item.file.name, size: item.file.size, type: item.file.type } : undefined,
    });
  });

  // 4. Retrieval (The "Pickup") + Burn on Read OR Multiple-Time Access
  app.post("/api/pickup", (req, res) => {
    const { pin } = req.body;

    if (!pin || typeof pin !== "string") {
      return res.status(400).json({ error: "PIN is required." });
    }

    const item = payloadStore.get(pin);

    if (!item) {
      return res.status(404).json({
        success: false,
        error: "Payload not found or already burned.",
      });
    }

    const now = Date.now();
    if (item.expiresAt <= now) {
      payloadStore.delete(pin);
      return res.status(410).json({
        success: false,
        error: "Session expired. Payload was automatically destroyed after 10 minutes.",
      });
    }

    // Increment read counter
    item.readCount += 1;
    let isBurned = false;

    if (item.shareMode === "burn_on_read") {
      // Single-read policy: Delete immediately
      payloadStore.delete(pin);
      isBurned = true;
      console.log(`[Burner Room] PIN ${pin} single-read retrieved and BURNED from server memory.`);
    } else {
      // Multiple-read policy: Payload stays alive until 10m TTL expires or sender burns manually
      console.log(`[Burner Room] PIN ${pin} retrieved (multi-share, read #${item.readCount}). Still alive.`);
    }

    return res.json({
      success: true,
      isBurned,
      shareMode: item.shareMode,
      readCount: item.readCount,
      burnedAt: isBurned ? now : undefined,
      payload: {
        pin: item.pin,
        type: item.type,
        shareMode: item.shareMode,
        readCount: item.readCount,
        textContent: item.textContent,
        file: item.file,
        createdAt: item.createdAt,
        expiresAt: item.expiresAt,
        ttlSeconds: item.ttlSeconds,
        status: isBurned ? "retrieved" : "pending",
      },
    });
  });

  // 5. Manual Instant Burn from Sender
  app.post("/api/burn", (req, res) => {
    const { pin } = req.body;
    if (pin && payloadStore.has(pin)) {
      payloadStore.delete(pin);
      console.log(`[Burner Room] PIN ${pin} manually burned by user.`);
      return res.json({ success: true, message: "Payload destroyed immediately." });
    }
    return res.json({ success: true, message: "Session already cleared." });
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
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Burner Room server running on port ${PORT}`);
  });
}

startServer();
