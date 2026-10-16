import express, { Request, Response } from "express";
import path from "node:path";
import { createServer as createViteServer } from "vite";
import apiApp, { BOOT_ID } from "./src/server/app";

export { BOOT_ID, apiApp };
export default apiApp;

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

export async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    apiApp.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    apiApp.use(express.static(distPath));
    apiApp.get("*", (_req: Request, res: Response) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  const server = apiApp.listen(PORT, "0.0.0.0", () => {
    console.log(`Burner Room server running on port ${PORT} [Boot ID: ${BOOT_ID}]`);
  });

  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  server.requestTimeout = 300000;
  return server;
}

// Automatically start server when executed directly as main script
startServer().catch((err) => {
  console.error("Failed to start Burner Room server:", err);
});
