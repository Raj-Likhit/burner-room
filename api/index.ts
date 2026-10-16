import type { Request, Response } from "express";
import app from "../server";

/**
 * Burner Room - Serverless Gateway & API Handler
 * 
 * If BURNER_BACKEND_URL is configured, proxies requests to the dedicated backend.
 * Otherwise, seamlessly serves via the Express application instance in memory,
 * preventing 503 "Transfer Unavailable" errors across all hosting environments.
 */
export default async function handler(req: Request, res: Response) {
  const backendUrl = process.env.BURNER_BACKEND_URL;

  if (backendUrl) {
    try {
      const targetUrl = new URL(req.url || "", backendUrl).toString();
      const response = await fetch(targetUrl, {
        method: req.method,
        headers: req.headers as any,
        body: req.method !== "GET" && req.method !== "HEAD" ? (req as any).body : undefined,
      });

      res.status(response.status);
      response.headers.forEach((val, key) => res.setHeader(key, val));
      const buffer = await response.arrayBuffer();
      return res.send(Buffer.from(buffer));
    } catch (err: any) {
      console.warn("Proxy to BURNER_BACKEND_URL failed, falling back to local app handler:", err);
    }
  }

  // Handle via Express application
  return app(req, res);
}
