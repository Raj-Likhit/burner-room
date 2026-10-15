import type { Request, Response } from "express";

/**
 * Burner Room - Serverless Gateway Notice
 * 
 * Ephemeral RAM-only state with zero-persistence and streaming delivery
 * is owned exclusively by the dedicated single-instance Node server (server.ts).
 * Multi-instance serverless functions do not share memory and cannot hold state.
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
      return res.status(502).json({
        error: {
          code: "PROXY_FAILED",
          message: "Failed to forward request to dedicated Burner Room backend server.",
        },
      });
    }
  }

  return res.status(503).json({
    error: {
      code: "SERVERLESS_UNSUPPORTED",
      message: "Burner Room requires the dedicated long-lived Node.js server (server.ts) to maintain ephemeral RAM state. Please connect directly to the primary server instance.",
    },
  });
}
