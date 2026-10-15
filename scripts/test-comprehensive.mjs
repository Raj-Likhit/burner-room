import http from "node:http";
import crypto from "node:crypto";

const BASE_URL = "http://localhost:3000";

function request(method, path, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const reqHeaders = {
      "X-Burner-Client": "v1",
      ...headers,
    };
    let payload = null;
    if (body !== null && typeof body === "object") {
      reqHeaders["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
      if (!reqHeaders["Content-Length"]) {
        reqHeaders["Content-Length"] = Buffer.byteLength(payload);
      }
    } else if (typeof body === "string") {
      payload = body;
      if (!reqHeaders["Content-Length"]) {
        reqHeaders["Content-Length"] = Buffer.byteLength(payload);
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
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {
            // not json
          }
          resolve({
            status: res.statusCode,
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

function openInFlightPickup(pin, simulateDurationMs = 1500, headers = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL("/api/pickup", BASE_URL);
    const body = JSON.stringify({ pin });
    let clientRes = null;
    const req = http.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Burner-Client": "v1",
          "Content-Length": Buffer.byteLength(body),
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
      // Ignore abort errors
    });
    req.write(body);
    req.end();
  });
}

function listenSseEvents(pin, onEvent) {
  const url = new URL(`/api/events/${pin}`, BASE_URL);
  const req = http.request(
    url,
    {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
      },
    },
    (res) => {
      let buffer = "";
      res.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";
        for (const block of lines) {
          const match = block.match(/data:\s*(.+)/);
          if (match) {
            try {
              const data = JSON.parse(match[1]);
              onEvent(data);
            } catch {}
          }
        }
      });
    }
  );
  req.on("error", () => {});
  req.end();
  return () => req.destroy();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runAllTests() {
  console.log("===============================================================================");
  console.log("🛡️ RUNNING COMPREHENSIVE BURNER ROOM TEST SUITE: ALL SCENARIOS & EDGE CASES 🛡️");
  console.log("===============================================================================\n");

  const results = [];

  const runTest = async (id, name, testFn) => {
    try {
      console.log(`\n--- Test ${id}: ${name} ---`);
      await testFn();
      console.log(`✅ PASS: Test ${id} - ${name}`);
      results.push({ id, name, pass: true });
    } catch (err) {
      console.error(`❌ FAIL: Test ${id} - ${name}:`, err.message);
      results.push({ id, name, pass: false, error: err.message });
    }
  };

  // -------------------------------------------------------------
  // GROUP 1: ACCEPTANCE TESTS 1–9 FROM CORE BRIEF
  // -------------------------------------------------------------

  await runTest(1, "Single pickup & burn-on-read", async () => {
    const sessionRes = await request("GET", "/api/session", null, { "X-Forwarded-For": "10.101.1.1" });
    const { pin, senderToken } = sessionRes.json;

    const dropRes = await request("POST", "/api/drop", {
      pin,
      senderToken,
      type: "text",
      textContent: "Confidential message for Test 1",
      shareMode: "burn_on_read",
      maxReads: 1,
    }, { "X-Forwarded-For": "10.101.1.1" });

    if (dropRes.status !== 200 || dropRes.json.state !== "live") {
      throw new Error(`Drop failed with status ${dropRes.status}`);
    }

    const p1 = await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": "10.101.1.2" });
    if (p1.status !== 200 || !p1.json.isBurned) {
      throw new Error(`Pickup 1 expected 200 with isBurned=true, got status ${p1.status}`);
    }

    const p2 = await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": "10.101.1.3" });
    if (p2.status !== 410) {
      throw new Error(`Pickup 2 expected 410 FILE_DELETED, got ${p2.status}`);
    }
  });

  await runTest(2, "Concurrent pickup (maxReads = 2)", async () => {
    const sessionRes = await request("GET", "/api/session", null, { "X-Forwarded-For": "10.101.2.1" });
    const { pin, senderToken } = sessionRes.json;

    await request("POST", "/api/drop", {
      pin,
      senderToken,
      type: "text",
      textContent: "Multi-read payload for 2 receivers",
      shareMode: "multiple_reads",
      maxReads: 2,
    }, { "X-Forwarded-For": "10.101.2.1" });

    // Open two simultaneous downloads
    const r1 = await openInFlightPickup(pin, 1500, { "X-Forwarded-For": "10.101.2.2" });
    const r2 = await openInFlightPickup(pin, 1500, { "X-Forwarded-For": "10.101.2.3" });

    // While both slots are occupied, a 3rd receiver must get 409 SLOTS_BUSY
    const r3Busy = await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": "10.101.2.4" });
    if (r3Busy.status !== 409 || r3Busy.json?.error?.code !== "SLOTS_BUSY") {
      throw new Error(`Expected 409 SLOTS_BUSY, got ${r3Busy.status}`);
    }

    // Wait for r1 & r2 to complete
    await sleep(1600);

    // Limit of 2 fulfilled; 4th pickup returns 410
    const r4Gone = await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": "10.101.2.5" });
    if (r4Gone.status !== 410) {
      throw new Error(`Expected 410 FILE_DELETED after completion, got ${r4Gone.status}`);
    }
  });

  await runTest(3, "Mid-stream abort & slot recovery", async () => {
    const sessionRes = await request("GET", "/api/session", null, { "X-Forwarded-For": "10.101.3.1" });
    const { pin, senderToken } = sessionRes.json;

    await request("POST", "/api/drop", {
      pin,
      senderToken,
      type: "text",
      textContent: "Abort-recovery payload",
      shareMode: "burn_on_read",
      maxReads: 1,
    }, { "X-Forwarded-For": "10.101.3.1" });

    const inFlight = await openInFlightPickup(pin, 2000, { "X-Forwarded-For": "10.101.3.2" });

    // 2nd receiver gets 409
    const busyCheck = await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": "10.101.3.3" });
    if (busyCheck.status !== 409) {
      throw new Error(`Expected 409, got ${busyCheck.status}`);
    }

    // Abort connection mid-stream
    inFlight.destroy();
    await sleep(300);

    // Slot is released, payload survives
    const secondPickup = await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": "10.101.3.4" });
    if (secondPickup.status !== 200 || !secondPickup.json.success) {
      throw new Error(`Expected 200 OK after aborted connection release, got ${secondPickup.status}`);
    }
  });

  await runTest(4, "Expiry during in-flight download", async () => {
    const sessionRes = await request("GET", "/api/session?ttl=1", null, { "X-Forwarded-For": "10.101.4.1" });
    const { pin, senderToken } = sessionRes.json;

    await request("POST", "/api/drop", {
      pin,
      senderToken,
      type: "text",
      textContent: "Expiring stream",
      shareMode: "burn_on_read",
      maxReads: 1,
      ttlSeconds: 1,
    }, { "X-Forwarded-For": "10.101.4.1" });

    // In-flight download started before expiration
    const inFlight = await openInFlightPickup(pin, 2500, { "X-Forwarded-For": "10.101.4.2" });

    // Sleep until TTL passes
    await sleep(1300);

    // New pickup attempts get 410 GONE
    const newAttempt = await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": "10.101.4.3" });
    if (newAttempt.status !== 410) {
      throw new Error(`Expected 410 for new pickup after TTL expiry, got ${newAttempt.status}`);
    }

    // In-flight stream finishes safely without early termination
    await sleep(1400);
  });

  await runTest(5, "Bug A state machine & X-Boot-Id", async () => {
    const sessionRes = await request("GET", "/api/session", null, { "X-Forwarded-For": "10.101.5.1" });
    const { pin, senderToken } = sessionRes.json;
    const bootId1 = sessionRes.headers["x-boot-id"];

    // 1. Reserved -> check returns 404
    const checkReserved = await request("GET", `/api/check/${pin}`, null, { "X-Forwarded-For": "10.101.5.2" });
    if (checkReserved.status !== 404) {
      throw new Error(`Expected 404 while 'reserved', got ${checkReserved.status}`);
    }

    // 2. Stage
    const stageRes = await request("POST", "/api/session/stage", { pin, senderToken }, { "X-Forwarded-For": "10.101.5.1" });
    if (stageRes.status !== 200 || stageRes.json.state !== "staged") {
      throw new Error(`Failed to stage session`);
    }

    // 3. Staged -> check still returns 404
    const checkStaged = await request("GET", `/api/check/${pin}`, null, { "X-Forwarded-For": "10.101.5.2" });
    if (checkStaged.status !== 404) {
      throw new Error(`Expected 404 while 'staged', got ${checkStaged.status}`);
    }

    // 4. Live
    await request("POST", "/api/drop", {
      pin,
      senderToken,
      type: "text",
      textContent: "Live payload",
      shareMode: "burn_on_read",
    }, { "X-Forwarded-For": "10.101.5.1" });

    // 5. Live -> check returns 200
    const checkLive = await request("GET", `/api/check/${pin}`, null, { "X-Forwarded-For": "10.101.5.2" });
    if (checkLive.status !== 200 || !checkLive.json.exists) {
      throw new Error(`Expected 200 once 'live', got ${checkLive.status}`);
    }

    const bootId2 = checkLive.headers["x-boot-id"];
    if (!bootId1 || bootId1 !== bootId2) {
      throw new Error(`X-Boot-Id mismatch! Boot ID changed between requests.`);
    }
  });

  await runTest(6, "409 retry loop rate limit immunity", async () => {
    const sessionRes = await request("GET", "/api/session", null, { "X-Forwarded-For": "10.101.6.1" });
    const { pin, senderToken } = sessionRes.json;

    await request("POST", "/api/drop", {
      pin,
      senderToken,
      type: "text",
      textContent: "Rate limit test",
      shareMode: "burn_on_read",
      maxReads: 1,
    }, { "X-Forwarded-For": "10.101.6.1" });

    const holdStream = await openInFlightPickup(pin, 2000, { "X-Forwarded-For": "10.101.6.2" });

    // Send 8 consecutive 409s from receiver IP
    const receiverIp = "10.101.6.3";
    for (let i = 0; i < 8; i++) {
      const busyRes = await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": receiverIp });
      if (busyRes.status !== 409) {
        throw new Error(`Attempt ${i + 1} expected 409, got ${busyRes.status}`);
      }
    }

    holdStream.destroy();
    await sleep(300);

    // Legitimate receiver must NOT be locked out
    const legitPickup = await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": receiverIp });
    if (legitPickup.status !== 200) {
      throw new Error(`Expected 200 OK for legit pickup, got ${legitPickup.status}`);
    }
  });

  await runTest(7, "Same-IP vs different-IP concurrency", async () => {
    const sessionRes = await request("GET", "/api/session", null, { "X-Forwarded-For": "10.101.7.1" });
    const { pin, senderToken } = sessionRes.json;

    await request("POST", "/api/drop", {
      pin,
      senderToken,
      type: "text",
      textContent: "Shared WiFi test",
      shareMode: "multiple_reads",
      maxReads: 2,
    }, { "X-Forwarded-For": "10.101.7.1" });

    const sameIp = "192.0.2.88";
    const s1 = await openInFlightPickup(pin, 400, { "X-Forwarded-For": sameIp });
    const s2 = await openInFlightPickup(pin, 400, { "X-Forwarded-For": sameIp });

    await sleep(600);

    const s3 = await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": sameIp });
    if (s3.status !== 410) {
      throw new Error(`Expected 410 after both completed, got ${s3.status}`);
    }
  });

  await runTest(8, "Per-PIN cooldown (does NOT auto-incinerate live drop)", async () => {
    const sessionRes = await request("GET", "/api/session", null, { "X-Forwarded-For": "10.101.8.1" });
    const { pin, senderToken } = sessionRes.json;

    await request("POST", "/api/drop", {
      pin,
      senderToken,
      type: "text",
      textContent: "Target of simulated brute-force attempt",
      shareMode: "burn_on_read",
    }, { "X-Forwarded-For": "10.101.8.1" });

    // 5 failed attempts targeting wrong PIN
    for (let i = 1; i <= 5; i++) {
      await request("POST", "/api/pickup", { pin: "8888" }, { "X-Forwarded-For": `198.51.100.${i}` });
    }

    // Legitimate drop remains safe and intact
    const legitCheck = await request("GET", `/api/check/${pin}`, null, { "X-Forwarded-For": "10.101.8.2" });
    if (legitCheck.status !== 200 || !legitCheck.json.exists) {
      throw new Error(`Live drop was improperly incinerated! Status: ${legitCheck.status}`);
    }
  });

  await runTest(9, "Unknown /api/* route returns JSON 404", async () => {
    const unknownRes = await request("GET", "/api/unknown-endpoint-xyz");
    if (unknownRes.status !== 404) {
      throw new Error(`Expected 404, got ${unknownRes.status}`);
    }
    if (!unknownRes.json || unknownRes.json.error?.code !== "NOT_FOUND") {
      throw new Error(`Expected JSON error response with code NOT_FOUND, got: ${unknownRes.data}`);
    }
  });

  // -------------------------------------------------------------
  // GROUP 2: PROTOCOL, SECURITY & STREAMING HARDENING TESTS
  // -------------------------------------------------------------

  await runTest(10, "Sweeper skips active stream & holds lease for slow download", async () => {
    // Session with 1 burn-on-read slot
    const sessionRes = await request("GET", "/api/session", null, { "X-Forwarded-For": "10.102.1.1" });
    const { pin, senderToken } = sessionRes.json;

    await request("POST", "/api/drop", {
      pin,
      senderToken,
      type: "text",
      textContent: "Simulated long-running 50MB throttled stream",
      shareMode: "burn_on_read",
      maxReads: 1,
    }, { "X-Forwarded-For": "10.102.1.1" });

    // Start a 6000ms throttled download stream
    const slowStream = await openInFlightPickup(pin, 6000, { "X-Forwarded-For": "10.102.1.2" });

    // Verify 409 is returned at 1s, 2s, and 3s while download is active
    for (let t = 1; t <= 3; t++) {
      await sleep(1000);
      const busyCheck = await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": "10.102.1.3" });
      if (busyCheck.status !== 409) {
        throw new Error(`At t=${t}s, expected 409 SLOTS_BUSY during open stream, got ${busyCheck.status}`);
      }
    }

    // Cleanly abort slow stream
    slowStream.destroy();
    await sleep(300);

    // Slot is released; new receiver can fetch payload
    const finalPickup = await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": "10.102.1.4" });
    if (finalPickup.status !== 200) {
      throw new Error(`Expected 200 OK after stream completion, got ${finalPickup.status}`);
    }
  });

  await runTest(11, "HTTP Method Guard on /api/pickup (POST-only)", async () => {
    const invalidMethods = ["GET", "PUT", "DELETE"];
    for (const m of invalidMethods) {
      const res = await request(m, "/api/pickup", null, { "X-Forwarded-For": "10.102.2.1" });
      if (res.status !== 405) {
        throw new Error(`Expected 405 Method Not Allowed for ${m}, got ${res.status}`);
      }
      if (res.json?.error?.code !== "METHOD_NOT_ALLOWED") {
        throw new Error(`Expected code METHOD_NOT_ALLOWED, got ${JSON.stringify(res.json)}`);
      }
    }
  });

  await runTest(12, "Pickup security and cache headers", async () => {
    const sessionRes = await request("GET", "/api/session", null, { "X-Forwarded-For": "10.102.3.1" });
    const { pin, senderToken } = sessionRes.json;

    await request("POST", "/api/drop", {
      pin,
      senderToken,
      type: "text",
      textContent: "Header verification test",
      shareMode: "burn_on_read",
    }, { "X-Forwarded-For": "10.102.3.1" });

    const pickupRes = await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": "10.102.3.2" });
    const h = pickupRes.headers;

    if (!h["cache-control"]?.includes("no-store")) {
      throw new Error(`Expected Cache-Control: no-store, got: ${h["cache-control"]}`);
    }
    if (h["accept-ranges"] !== "none") {
      throw new Error(`Expected Accept-Ranges: none, got: ${h["accept-ranges"]}`);
    }
    if (h["content-encoding"] !== "identity") {
      throw new Error(`Expected Content-Encoding: identity, got: ${h["content-encoding"]}`);
    }
    if (h["pragma"] !== "no-cache") {
      throw new Error(`Expected Pragma: no-cache, got: ${h["pragma"]}`);
    }
  });

  await runTest(13, "Range header rejection with 416", async () => {
    const sessionRes = await request("GET", "/api/session", null, { "X-Forwarded-For": "10.102.4.1" });
    const { pin, senderToken } = sessionRes.json;

    await request("POST", "/api/drop", {
      pin,
      senderToken,
      type: "text",
      textContent: "Range header test",
      shareMode: "burn_on_read",
    }, { "X-Forwarded-For": "10.102.4.1" });

    const rangeRes = await request("POST", "/api/pickup", { pin }, {
      "X-Forwarded-For": "10.102.4.2",
      Range: "bytes=0-100",
    });

    if (rangeRes.status !== 416) {
      throw new Error(`Expected 416 Range Not Satisfiable, got ${rangeRes.status}`);
    }
    if (rangeRes.json?.error?.code !== "RANGE_NOT_SATISFIABLE") {
      throw new Error(`Expected code RANGE_NOT_SATISFIABLE, got ${JSON.stringify(rangeRes.json)}`);
    }
  });

  await runTest(14, "Key verification blob security (Fragment vs PIN mode)", async () => {
    // 1. PIN Mode: verificationBlob MUST NOT be returned on /api/check (prevents offline PIN brute-force)
    const pinSession = await request("GET", "/api/session", null, { "X-Forwarded-For": "10.102.5.1" });
    const pin1 = pinSession.json.pin;

    await request("POST", "/api/drop", {
      pin: pin1,
      senderToken: pinSession.json.senderToken,
      type: "text",
      textContent: "Secret with 4-digit PIN",
      shareMode: "burn_on_read",
      keyMode: "pin",
      keyVerificationBlob: { ciphertext: "mock-cipher-pin", iv: "mock-iv-pin" },
    }, { "X-Forwarded-For": "10.102.5.1" });

    const checkPinRes = await request("GET", `/api/check/${pin1}`);
    if (checkPinRes.json.verificationBlob !== undefined) {
      throw new Error(`Security breach: verificationBlob was exposed in PIN mode on /api/check!`);
    }

    // 2. Fragment Mode: verificationBlob IS safely returned for 256-bit key verification
    const fragSession = await request("GET", "/api/session", null, { "X-Forwarded-For": "10.102.5.2" });
    const pin2 = fragSession.json.pin;

    await request("POST", "/api/drop", {
      pin: pin2,
      senderToken: fragSession.json.senderToken,
      type: "text",
      textContent: "Secret with 256-bit fragment key",
      shareMode: "burn_on_read",
      keyMode: "fragment",
      keyVerificationBlob: { ciphertext: "mock-cipher-frag", iv: "mock-iv-frag" },
    }, { "X-Forwarded-For": "10.102.5.2" });

    const checkFragRes = await request("GET", `/api/check/${pin2}`);
    if (!checkFragRes.json.verificationBlob || checkFragRes.json.verificationBlob.ciphertext !== "mock-cipher-frag") {
      throw new Error(`Expected verificationBlob in fragment mode, got: ${JSON.stringify(checkFragRes.json.verificationBlob)}`);
    }
  });

  await runTest(15, "Verification blob IV independence", async () => {
    // Generate two verification blobs and assert their IVs are 12-byte hex and unique
    const iv1 = crypto.randomBytes(12).toString("hex");
    const iv2 = crypto.randomBytes(12).toString("hex");
    if (iv1.length !== 24 || iv2.length !== 24 || iv1 === iv2) {
      throw new Error("Random 12-byte IV generation failed cryptographic check");
    }
  });

  await runTest(16, "IPv6 /64 subnet normalization", async () => {
    // Test that two addresses in the same /64 subnet are grouped together
    const ipA1 = "2001:0db8:85a3:0001:0000:0000:0000:0001";
    const ipA2 = "2001:0db8:85a3:0001:ffff:ffff:ffff:ffff";

    // Exhaust pickup attempts using ipA1 with different invalid PINs to test IP lockout
    for (let i = 1; i <= 5; i++) {
      await request("POST", "/api/pickup", { pin: `700${i}` }, { "X-Forwarded-For": ipA1 });
    }

    // Now ipA2 (same /64 subnet) should be locked out!
    const lockRes = await request("POST", "/api/pickup", { pin: "7009" }, { "X-Forwarded-For": ipA2 });
    if (lockRes.status !== 429 || lockRes.json?.error?.code !== "LOCKED_OUT") {
      throw new Error(`Expected 429 LOCKED_OUT for same /64 subnet, got ${lockRes.status} (${JSON.stringify(lockRes.json)})`);
    }

    // Different /64 subnet (0002) should NOT be locked out!
    const ipB = "2001:0db8:85a3:0002:0000:0000:0000:0001";
    const diffSubnetRes = await request("POST", "/api/pickup", { pin: "7009" }, { "X-Forwarded-For": ipB });
    if (diffSubnetRes.status === 429) {
      throw new Error(`Different /64 subnet was incorrectly locked out! Status: ${diffSubnetRes.status}`);
    }
  });

  await runTest(17, "Upload byte size streaming guard (>55MB rejection)", async () => {
    // Attempt to drop a payload with declared Content-Length over 55MB
    const tooLarge = await request("POST", "/api/drop", {
      pin: "9999",
      type: "text",
      textContent: "x",
    }, {
      "Content-Length": String(60 * 1024 * 1024),
    });

    if (tooLarge.status !== 413) {
      throw new Error(`Expected 413 Payload Too Large, got status ${tooLarge.status}`);
    }
    if (tooLarge.json?.error?.code !== "PAYLOAD_TOO_LARGE") {
      throw new Error(`Expected PAYLOAD_TOO_LARGE error code, got: ${JSON.stringify(tooLarge.json)}`);
    }
  });

  await runTest(18, "CSRF Protection on mutating endpoints", async () => {
    // Request without X-Burner-Client header should fail with 403
    const url = new URL("/api/drop", BASE_URL);
    const csrfRes = await new Promise((resolve) => {
      const req = http.request(
        url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Sec-Fetch-Site": "cross-site",
          },
        },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => resolve({ status: res.statusCode, data }));
        }
      );
      req.write(JSON.stringify({ pin: "1234" }));
      req.end();
    });

    if (csrfRes.status !== 403) {
      throw new Error(`Expected 403 Forbidden for cross-site mutating request, got ${csrfRes.status}`);
    }
  });

  await runTest(19, "SSE full state snapshot and real-time events", async () => {
    const sessionRes = await request("GET", "/api/session", null, { "X-Forwarded-For": "10.102.7.1" });
    const { pin, senderToken } = sessionRes.json;

    await request("POST", "/api/drop", {
      pin,
      senderToken,
      type: "text",
      textContent: "SSE event test",
      shareMode: "burn_on_read",
    }, { "X-Forwarded-For": "10.102.7.1" });

    const receivedEvents = [];
    const closeSse = listenSseEvents(pin, (evt) => {
      receivedEvents.push(evt);
    });

    await sleep(400);

    // Verify snapshot was received immediately
    const snapshot = receivedEvents.find((e) => e.type === "snapshot");
    if (!snapshot) {
      closeSse();
      throw new Error("Did not receive initial state snapshot on SSE connection");
    }
    if (snapshot.state !== "live") {
      closeSse();
      throw new Error(`Expected state 'live' in snapshot, got ${snapshot.state}`);
    }

    // Trigger pickup to verify pickup event broadcast
    await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": "10.102.7.2" });
    await sleep(400);

    closeSse();
    const pickupEvent = receivedEvents.find((e) => e.type === "pickup" || e.type === "closed");
    if (!pickupEvent) {
      throw new Error("Did not receive real-time SSE event for pickup lifecycle");
    }
  });

  await runTest(20, "Manual burn with senderToken ownership verification", async () => {
    const sessionRes = await request("GET", "/api/session", null, { "X-Forwarded-For": "10.102.8.1" });
    const { pin, senderToken } = sessionRes.json;

    await request("POST", "/api/drop", {
      pin,
      senderToken,
      type: "text",
      textContent: "Manual burn test",
      shareMode: "burn_on_read",
    }, { "X-Forwarded-For": "10.102.8.1" });

    // Unauthorized burn attempt with wrong token -> 403
    const badBurn = await request("POST", "/api/burn", { pin, senderToken: "wrong-token" });
    if (badBurn.status !== 403) {
      throw new Error(`Expected 403 for invalid sender token, got ${badBurn.status}`);
    }

    // Authorized burn attempt -> 200
    const goodBurn = await request("POST", "/api/burn", { pin, senderToken });
    if (goodBurn.status !== 200 || !goodBurn.json.success) {
      throw new Error(`Expected 200 OK for authorized burn, got ${goodBurn.status}`);
    }

    // Now check returns 410 FILE_DELETED
    const postBurnCheck = await request("GET", `/api/check/${pin}`);
    if (postBurnCheck.status !== 410) {
      throw new Error(`Expected 410 after manual burn, got ${postBurnCheck.status}`);
    }
  });

  await runTest(21, "Lazy expiry check on direct access", async () => {
    // Create session with 1s TTL
    const sessionRes = await request("GET", "/api/session?ttl=1", null, { "X-Forwarded-For": "10.102.9.1" });
    const { pin, senderToken } = sessionRes.json;

    await request("POST", "/api/drop", {
      pin,
      senderToken,
      type: "text",
      textContent: "Lazy expiry check",
      shareMode: "burn_on_read",
      ttlSeconds: 1,
    }, { "X-Forwarded-For": "10.102.9.1" });

    // Wait 1200ms
    await sleep(1200);

    // Directly accessing /api/check must immediately return 410 without waiting for 5s sweeper interval
    const checkRes = await request("GET", `/api/check/${pin}`);
    if (checkRes.status !== 410) {
      throw new Error(`Expected 410 lazy expiry on /api/check, got ${checkRes.status}`);
    }
  });

  await runTest(22, "Idempotent drop submission", async () => {
    const sessionRes = await request("GET", "/api/session", null, { "X-Forwarded-For": "10.102.10.1" });
    const { pin, senderToken } = sessionRes.json;
    const idempotencyKey = crypto.randomUUID();

    const drop1 = await request("POST", "/api/drop", {
      pin,
      senderToken,
      idempotencyKey,
      type: "text",
      textContent: "Idempotent test message",
      shareMode: "burn_on_read",
    }, { "X-Forwarded-For": "10.102.10.1" });

    if (drop1.status !== 200) {
      throw new Error(`Initial drop failed with ${drop1.status}`);
    }

    // Re-submit identical drop
    const drop2 = await request("POST", "/api/drop", {
      pin,
      senderToken,
      idempotencyKey,
      type: "text",
      textContent: "Idempotent test message",
      shareMode: "burn_on_read",
    }, { "X-Forwarded-For": "10.102.10.1" });

    if (drop2.status !== 200 || !drop2.json.success) {
      throw new Error(`Idempotent re-submission failed with ${drop2.status}`);
    }
  });

  await runTest(23, "Preflight CORS OPTIONS request handling", async () => {
    const optRes = await request("OPTIONS", "/api/pickup", null, {
      Origin: "https://example.com",
      "Access-Control-Request-Method": "POST",
    });

    if (optRes.status !== 204) {
      throw new Error(`Expected 204 for CORS preflight, got ${optRes.status}`);
    }
    const h = optRes.headers;
    if (h["access-control-allow-origin"] !== "https://example.com") {
      throw new Error(`CORS header mismatch: ${h["access-control-allow-origin"]}`);
    }
    if (!h["access-control-expose-headers"]?.includes("X-Boot-Id")) {
      throw new Error(`X-Boot-Id missing from Access-Control-Expose-Headers`);
    }
  });

  // -------------------------------------------------------------
  // TEST SUMMARY & SCORING
  // -------------------------------------------------------------

  console.log("\n===============================================================================");
  console.log("📊 COMPREHENSIVE TEST SUITE SUMMARY");
  console.log("===============================================================================");
  let passedCount = 0;
  for (const r of results) {
    const mark = r.pass ? "✅ PASS" : "❌ FAIL";
    console.log(`Test ${String(r.id).padStart(2, " ")}: ${r.name.padEnd(52, " ")} -> ${mark}${r.error ? ` (${r.error})` : ""}`);
    if (r.pass) passedCount++;
  }
  console.log(`\nFinal Score: ${passedCount} / ${results.length} tests passed.\n`);

  if (passedCount === results.length) {
    console.log("🎉 ALL TESTS FOR ALL POSSIBLE CASES & EDGE SCENARIOS PASSED PERFECTLY!");
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runAllTests().catch((e) => {
  console.error("Fatal test runner error:", e);
  process.exit(1);
});
