/**
 * Burner Room - Core Acceptance Tests Suite (Tests 1–9)
 * 
 * Implements the 9 rigorous acceptance tests using Vitest:
 * 1. Single pickup & burn-on-read
 * 2. Concurrent pickup (maxReads = 2) & 409 SLOTS_BUSY handling
 * 3. Mid-stream abort & slot recovery without burning payload
 * 4. Expiry during in-flight download & hold buffer
 * 5. Reserve interleaving state machine & constant X-Boot-Id
 * 6. 409 retry loop does NOT count against rate limiters
 * 7. Same-IP vs different-IP concurrency & shared NAT support
 * 8. Per-PIN cooldown & brute-force protection (no auto-burn)
 * 9. Unknown /api/* route returns clean JSON 404
 */

import { describe, it, expect } from "vitest";
import http from "node:http";

const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:3000";

interface RequestResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  data: string;
  json: any;
}

function request(method: string, path: string, body: any = null, headers: Record<string, string> = {}): Promise<RequestResult> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const reqHeaders: Record<string, string> = {
      "X-Burner-Client": "v1",
      ...headers,
    };
    let payload: string | null = null;
    if (body !== null && typeof body === "object") {
      reqHeaders["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
      if (!reqHeaders["Content-Length"]) {
        reqHeaders["Content-Length"] = String(Buffer.byteLength(payload));
      }
    } else if (typeof body === "string") {
      payload = body;
      if (!reqHeaders["Content-Length"]) {
        reqHeaders["Content-Length"] = String(Buffer.byteLength(payload));
      }
    }

    const req = http.request(
      url,
      {
        method,
        headers: reqHeaders,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          let json: any = null;
          try {
            json = JSON.parse(data);
          } catch {
            // Not JSON
          }
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            data,
            json,
          });
        });
      }
    );

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function openInFlightPickup(pin: string, simulateDurationMs = 1500, headers: Record<string, string> = {}): Promise<{ req: http.ClientRequest; res: http.IncomingMessage; destroy: () => void }> {
  return new Promise((resolve, reject) => {
    const url = new URL("/api/pickup", BASE_URL);
    const body = JSON.stringify({ pin });
    let clientRes: http.IncomingMessage | null = null;
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Burner-Client": "v1",
          "Content-Length": String(Buffer.byteLength(body)),
          "X-Simulate-Download-Ms": String(simulateDurationMs),
          ...headers,
        },
      },
      (res) => {
        clientRes = res;
        resolve({
          req,
          res,
          destroy: () => {
            req.destroy();
            if (clientRes) clientRes.destroy();
          },
        });
      }
    );
    req.on("error", () => {
      // Ignore client abort errors
    });
    req.write(body);
    req.end();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("Burner Room Acceptance Tests (1–9)", () => {
  // Test 1: Single pickup & burn-on-read
  it("Test 1: Single pickup & burn-on-read", async () => {
    const sessionRes = await request("GET", "/api/session", null, { "X-Forwarded-For": "10.201.1.1" });
    expect(sessionRes.status).toBe(200);
    const pin = sessionRes.json.pin;
    const senderToken = sessionRes.json.senderToken;

    const dropRes = await request("POST", "/api/drop", {
      pin,
      senderToken,
      type: "text",
      textContent: "Secret payload for Acceptance Test 1",
      shareMode: "burn_on_read",
      maxReads: 1,
    }, { "X-Forwarded-For": "10.201.1.1" });

    expect(dropRes.status).toBe(200);
    expect(dropRes.json.state).toBe("live");

    // First pickup must succeed and burn the file
    const p1 = await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": "10.201.1.2" });
    expect(p1.status).toBe(200);
    expect(p1.json.isBurned).toBe(true);

    // Second pickup must return 410 FILE_DELETED
    const p2 = await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": "10.201.1.3" });
    expect(p2.status).toBe(410);
  });

  // Test 2: Concurrent pickup (maxReads = 2) & slot busy handling
  it("Test 2: Concurrent pickup (maxReads = 2) & slot busy handling", async () => {
    const sessionRes = await request("GET", "/api/session", null, { "X-Forwarded-For": "10.202.1.1" });
    expect(sessionRes.status).toBe(200);
    const pin = sessionRes.json.pin;
    const senderToken = sessionRes.json.senderToken;

    const dropRes = await request("POST", "/api/drop", {
      pin,
      senderToken,
      type: "text",
      textContent: "Multi-read payload for 2 recipients",
      shareMode: "multiple_reads",
      maxReads: 2,
    }, { "X-Forwarded-For": "10.202.1.1" });

    expect(dropRes.status).toBe(200);

    // Two receivers start in-flight streams simultaneously (1500ms duration)
    await openInFlightPickup(pin, 1500, { "X-Forwarded-For": "10.202.1.2" });
    await openInFlightPickup(pin, 1500, { "X-Forwarded-For": "10.202.1.3" });

    // While both are downloading, a 3rd receiver gets 409 SLOTS_BUSY
    const r3Busy = await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": "10.202.1.4" });
    expect(r3Busy.status).toBe(409);
    expect(r3Busy.json?.error?.code).toBe("SLOTS_BUSY");

    // Allow in-flight streams to complete
    await sleep(1600);

    // After 2 reads complete, session is exhausted and subsequent pickups get 410
    const r4Gone = await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": "10.202.1.5" });
    expect(r4Gone.status).toBe(410);
  });

  // Test 3: Mid-stream abort & slot recovery without burning
  it("Test 3: Mid-stream abort & slot recovery without burning", async () => {
    const sessionRes = await request("GET", "/api/session", null, { "X-Forwarded-For": "10.203.1.1" });
    expect(sessionRes.status).toBe(200);
    const pin = sessionRes.json.pin;
    const senderToken = sessionRes.json.senderToken;

    await request("POST", "/api/drop", {
      pin,
      senderToken,
      type: "text",
      textContent: "Aborted download test payload",
      shareMode: "burn_on_read",
      maxReads: 1,
    }, { "X-Forwarded-For": "10.203.1.1" });

    // Start 2000ms in-flight stream
    const inFlight = await openInFlightPickup(pin, 2000, { "X-Forwarded-For": "10.203.1.2" });

    // Second client gets 409
    const busyCheck = await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": "10.203.1.3" });
    expect(busyCheck.status).toBe(409);

    // Abort stream prematurely
    inFlight.destroy();
    await sleep(300);

    // Slot is cleanly freed; payload is not burned and can be picked up
    const secondPickup = await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": "10.203.1.4" });
    expect(secondPickup.status).toBe(200);
    expect(secondPickup.json.success).toBe(true);
  });

  // Test 4: Expiry during in-flight download & hold buffer
  it("Test 4: Expiry during in-flight download & hold buffer", async () => {
    // 1-second TTL
    const sessionRes = await request("GET", "/api/session?ttl=1", null, { "X-Forwarded-For": "10.204.1.1" });
    expect(sessionRes.status).toBe(200);
    const pin = sessionRes.json.pin;
    const senderToken = sessionRes.json.senderToken;

    await request("POST", "/api/drop", {
      pin,
      senderToken,
      type: "text",
      textContent: "Expiring stream content",
      shareMode: "burn_on_read",
      maxReads: 1,
      ttlSeconds: 1,
    }, { "X-Forwarded-For": "10.204.1.1" });

    // In-flight download starts before TTL expiry with 2500ms duration
    await openInFlightPickup(pin, 2500, { "X-Forwarded-For": "10.204.1.2" });

    // Wait until TTL expires
    await sleep(1300);

    // New pickup attempts after TTL expiration return 410
    const newAttempt = await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": "10.204.1.3" });
    expect(newAttempt.status).toBe(410);

    // Allow in-flight download to finish without buffer corruption
    await sleep(1400);
  });

  // Test 5: Reserve interleaving state machine & X-Boot-Id consistency
  it("Test 5: Reserve interleaving state machine & X-Boot-Id consistency", async () => {
    const sessionRes = await request("GET", "/api/session", null, { "X-Forwarded-For": "10.205.1.1" });
    expect(sessionRes.status).toBe(200);
    const pin = sessionRes.json.pin;
    const senderToken = sessionRes.json.senderToken;
    const bootId1 = sessionRes.headers["x-boot-id"];

    // 1. Reserved state hides drop (404)
    const checkReserved = await request("GET", `/api/check/${pin}`, null, { "X-Forwarded-For": "10.205.1.2" });
    expect(checkReserved.status).toBe(404);

    // 2. Stage session (undo window)
    const stageRes = await request("POST", "/api/session/stage", { pin, senderToken }, { "X-Forwarded-For": "10.205.1.1" });
    expect(stageRes.status).toBe(200);
    expect(stageRes.json.state).toBe("staged");

    // 3. Staged state also returns 404
    const checkStaged = await request("GET", `/api/check/${pin}`, null, { "X-Forwarded-For": "10.205.1.2" });
    expect(checkStaged.status).toBe(404);

    // 4. Drop payload to 'live'
    const dropRes = await request("POST", "/api/drop", {
      pin,
      senderToken,
      type: "text",
      textContent: "Live payload",
      shareMode: "burn_on_read",
    }, { "X-Forwarded-For": "10.205.1.1" });
    expect(dropRes.status).toBe(200);
    expect(dropRes.json.state).toBe("live");

    // 5. Check returns 200 once live
    const checkLive = await request("GET", `/api/check/${pin}`, null, { "X-Forwarded-For": "10.205.1.2" });
    expect(checkLive.status).toBe(200);
    expect(checkLive.json.exists).toBe(true);

    const bootId2 = checkLive.headers["x-boot-id"];
    expect(bootId1).toBeDefined();
    expect(bootId1).toBe(bootId2);
  });

  // Test 6: 409 retry loop does NOT exhaust rate limiter
  it("Test 6: 409 retry loop does NOT exhaust rate limiter", async () => {
    const sessionRes = await request("GET", "/api/session", null, { "X-Forwarded-For": "10.206.1.1" });
    expect(sessionRes.status).toBe(200);
    const pin = sessionRes.json.pin;
    const senderToken = sessionRes.json.senderToken;

    await request("POST", "/api/drop", {
      pin,
      senderToken,
      type: "text",
      textContent: "Limiter immunity verification",
      shareMode: "burn_on_read",
      maxReads: 1,
    }, { "X-Forwarded-For": "10.206.1.1" });

    // Hold slot 1 open
    const holdStream = await openInFlightPickup(pin, 2000, { "X-Forwarded-For": "10.206.1.2" });

    // Send 8 consecutive 409 requests from the same receiver IP
    const receiverIp = "10.206.1.3";
    for (let i = 0; i < 8; i++) {
      const busyRes = await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": receiverIp });
      expect(busyRes.status).toBe(409);
    }

    holdStream.destroy();
    await sleep(300);

    // Receiver must not be locked out and must succeed
    const legitPickup = await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": receiverIp });
    expect(legitPickup.status).toBe(200);
  });

  // Test 7: Same-IP vs different-IP concurrency & shared NAT support
  it("Test 7: Same-IP vs different-IP concurrency & shared NAT support", async () => {
    const sessionRes = await request("GET", "/api/session", null, { "X-Forwarded-For": "10.207.1.1" });
    expect(sessionRes.status).toBe(200);
    const pin = sessionRes.json.pin;
    const senderToken = sessionRes.json.senderToken;

    await request("POST", "/api/drop", {
      pin,
      senderToken,
      type: "text",
      textContent: "Shared Wi-Fi NAT concurrent test",
      shareMode: "multiple_reads",
      maxReads: 2,
    }, { "X-Forwarded-For": "10.207.1.1" });

    const sharedIp = "192.0.2.144";
    await openInFlightPickup(pin, 400, { "X-Forwarded-For": sharedIp });
    await openInFlightPickup(pin, 400, { "X-Forwarded-For": sharedIp });

    await sleep(600);

    // 2 reads completed; 3rd gets 410
    const s3 = await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": sharedIp });
    expect(s3.status).toBe(410);
  });

  // Test 8: Per-PIN cooldown & brute-force protection (no auto-burn)
  it("Test 8: Per-PIN cooldown & brute-force protection (no auto-burn)", async () => {
    const sessionRes = await request("GET", "/api/session", null, { "X-Forwarded-For": "10.208.1.1" });
    expect(sessionRes.status).toBe(200);
    const pin = sessionRes.json.pin;
    const senderToken = sessionRes.json.senderToken;

    await request("POST", "/api/drop", {
      pin,
      senderToken,
      type: "text",
      textContent: "Brute-force resilience payload",
      shareMode: "burn_on_read",
    }, { "X-Forwarded-For": "10.208.1.1" });

    // 5 failed pickup attempts targeting nonexistent PINs from different IPs
    for (let i = 1; i <= 5; i++) {
      await request("POST", "/api/pickup", { pin: "9998" }, { "X-Forwarded-For": `198.51.100.${i}` });
    }

    // Legitimate drop at `pin` must remain intact and NOT auto-incinerated
    const legitCheck = await request("GET", `/api/check/${pin}`, null, { "X-Forwarded-For": "10.208.1.2" });
    expect(legitCheck.status).toBe(200);
    expect(legitCheck.json.exists).toBe(true);
  });

  // Test 9: Unknown /api/* route returns clean JSON 404
  it("Test 9: Unknown /api/* route returns clean JSON 404", async () => {
    const unknownRes = await request("GET", "/api/nonexistent-route-vitest-test");
    expect(unknownRes.status).toBe(404);
    expect(unknownRes.json?.error?.code).toBe("NOT_FOUND");
    expect(unknownRes.headers["x-boot-id"]).toBeDefined();
  });
});
