import type { Request, Response } from "express";
import apiApp from "../src/server/app";

/**
 * Burner Room - Serverless Gateway & API Handler
 * 
 * Proxies to BURNER_BACKEND_URL if configured (with stripped host headers to allow
 * upstream Cloud Run / reverse-proxy forwarding), or executes the in-memory apiApp directly
 * with proper async promise completion for serverless runtimes (Vercel, AWS Lambda).
 */
export default async function handler(req: Request, res: Response) {
  const backendUrl = process.env.BURNER_BACKEND_URL;

  if (backendUrl) {
    try {
      const targetUrl = new URL(req.url || "", backendUrl).toString();
      const headers: Record<string, string> = {};
      for (const [key, val] of Object.entries(req.headers)) {
        if (val === undefined) continue;
        const lower = key.toLowerCase();
        // Drop hop-by-hop and host headers that conflict with upstream Cloud Run / reverse proxies
        if (
          lower === "host" ||
          lower === "connection" ||
          lower === "keep-alive" ||
          lower === "transfer-encoding" ||
          lower === "content-length"
        ) {
          continue;
        }
        headers[lower] = Array.isArray(val) ? val.join(", ") : String(val);
      }

      let body: any = undefined;
      if (req.method !== "GET" && req.method !== "HEAD") {
        if (req.body) {
          body = typeof req.body === "string" || Buffer.isBuffer(req.body)
            ? req.body
            : JSON.stringify(req.body);
        }
      }

      const response = await fetch(targetUrl, {
        method: req.method,
        headers,
        body,
      });

      res.status(response.status);
      response.headers.forEach((val, key) => {
        const lower = key.toLowerCase();
        if (lower !== "content-encoding" && lower !== "transfer-encoding") {
          res.setHeader(key, val);
        }
      });
      const buffer = await response.arrayBuffer();
      return res.send(Buffer.from(buffer));
    } catch (err: any) {
      console.warn("Proxy to BURNER_BACKEND_URL failed, falling back to local apiApp:", err);
    }
  }

  // Handle directly using Express apiApp with promise completion
  return new Promise<void>((resolve, reject) => {
    apiApp(req, res, (err: any) => {
      if (err) return reject(err);
      resolve();
    });
    res.on("finish", resolve);
    res.on("close", resolve);
  });
}
