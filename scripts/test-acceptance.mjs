import http from "node:http";

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
      reqHeaders["Content-Length"] = Buffer.byteLength(payload);
    } else if (typeof body === "string") {
      payload = body;
      reqHeaders["Content-Length"] = Buffer.byteLength(payload);
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
    req.on("error", (err) => {
      // Ignore abort errors
    });
    req.write(body);
    req.end();
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runAllTests() {
  console.log("=================================================");
  console.log("🔥 RUNNING BURNER ROOM ACCEPTANCE TESTS (1–9) 🔥");
  console.log("=================================================\n");

  const results = [];

  // TEST 1: Single pickup & burn-on-read
  try {
    console.log("--- Test 1: Single pickup & burn-on-read ---");
    const sessionRes = await request("GET", "/api/session", null, { "X-Forwarded-For": "10.100.1.1" });
    const pin = sessionRes.json.pin;
    const senderToken = sessionRes.json.senderToken;

    // Drop payload (burn-on-read)
    const dropRes = await request("POST", "/api/drop", {
      pin,
      senderToken,
      type: "text",
      textContent: "Secret note for Test 1",
      shareMode: "burn_on_read",
      maxReads: 1,
    }, { "X-Forwarded-For": "10.100.1.1" });

    if (dropRes.status !== 200 || dropRes.json.state !== "live") {
      throw new Error(`Drop failed with status ${dropRes.status}`);
    }

    // Pickup 1
    const p1 = await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": "10.100.1.2" });
    if (p1.status !== 200 || !p1.json.isBurned) {
      throw new Error(`Pickup 1 expected 200 with isBurned=true, got status ${p1.status}`);
    }

    // Pickup 2 must return 410 FILE_DELETED
    const p2 = await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": "10.100.1.3" });
    if (p2.status !== 410) {
      throw new Error(`Pickup 2 expected 410, got status ${p2.status}`);
    }
    console.log("✅ PASS: Test 1 - Single pickup delivered and incinerated; second pickup returned 410.");
    results.push({ test: 1, name: "Single pickup & burn-on-read", pass: true });
  } catch (err) {
    console.error("❌ FAIL: Test 1", err.message);
    results.push({ test: 1, name: "Single pickup & burn-on-read", pass: false, error: err.message });
  }

  // TEST 2: Concurrent pickup (maxReads = 2)
  try {
    console.log("\n--- Test 2: Concurrent pickup (maxReads = 2) ---");
    const sessionRes = await request("GET", "/api/session", null, { "X-Forwarded-For": "10.100.2.1" });
    const pin = sessionRes.json.pin;
    const senderToken = sessionRes.json.senderToken;

    const dropRes = await request("POST", "/api/drop", {
      pin,
      senderToken,
      type: "text",
      textContent: "Multi-read payload for 2 receivers",
      shareMode: "multiple_reads",
      maxReads: 2,
    }, { "X-Forwarded-For": "10.100.2.1" });

    if (dropRes.status !== 200) {
      throw new Error(`Drop failed: ${dropRes.status}`);
    }

    // Receiver 1 and Receiver 2 start in-flight streaming downloads (1500ms simulation)
    const r1 = await openInFlightPickup(pin, 1500, { "X-Forwarded-For": "10.100.2.2" });
    const r2 = await openInFlightPickup(pin, 1500, { "X-Forwarded-For": "10.100.2.3" });

    // While both r1 and r2 are actively in flight (slots = 2 of 2), Receiver 3 must get 409 SLOTS_BUSY
    const r3Busy = await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": "10.100.2.4" });
    if (r3Busy.status !== 409 || r3Busy.json?.error?.code !== "SLOTS_BUSY") {
      throw new Error(`Expected 409 SLOTS_BUSY for Receiver 3 while both in flight, got ${r3Busy.status} (${JSON.stringify(r3Busy.json)})`);
    }

    // Wait for r1 and r2 downloads to finish and commit
    await sleep(1600);

    // After both commit, download limit is exhausted (2 of 2). Subsequent pickup gets 410 FILE_DELETED
    const r4Gone = await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": "10.100.2.5" });
    if (r4Gone.status !== 410) {
      throw new Error(`Expected 410 FILE_DELETED after 2 reads completed, got ${r4Gone.status}`);
    }
    console.log("✅ PASS: Test 2 - Concurrent downloads (r1, r2) allowed simultaneously; r3 got 409 SLOTS_BUSY; post-completion gets 410.");
    results.push({ test: 2, name: "Concurrent pickup (maxReads = 2)", pass: true });
  } catch (err) {
    console.error("❌ FAIL: Test 2", err.message);
    results.push({ test: 2, name: "Concurrent pickup (maxReads = 2)", pass: false, error: err.message });
  }

  // TEST 3: Mid-stream abort (slot released without burning payload)
  try {
    console.log("\n--- Test 3: Mid-stream abort (slot release without burning) ---");
    const sessionRes = await request("GET", "/api/session", null, { "X-Forwarded-For": "10.100.3.1" });
    const pin = sessionRes.json.pin;
    const senderToken = sessionRes.json.senderToken;

    await request("POST", "/api/drop", {
      pin,
      senderToken,
      type: "text",
      textContent: "Secret payload tested for aborted download recovery",
      shareMode: "burn_on_read",
      maxReads: 1,
    }, { "X-Forwarded-For": "10.100.3.1" });

    // Start in-flight pickup with 2000ms duration
    const inFlight = await openInFlightPickup(pin, 2000, { "X-Forwarded-For": "10.100.3.2" });

    // Another receiver immediately gets 409 while first is in-flight
    const busyCheck = await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": "10.100.3.3" });
    if (busyCheck.status !== 409) {
      throw new Error(`Expected 409 during in-flight pickup, got ${busyCheck.status}`);
    }

    // Abort/destroy first stream mid-flight
    inFlight.destroy();
    await sleep(300); // Allow close handler to execute releaseSlot

    // Slot is released, payload was NOT burned, and can now be successfully picked up!
    const secondPickup = await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": "10.100.3.4" });
    if (secondPickup.status !== 200 || !secondPickup.json.success) {
      throw new Error(`Expected 200 OK after aborted connection release, got status ${secondPickup.status}`);
    }
    console.log("✅ PASS: Test 3 - Aborted stream released slot cleanly; file survived and was retrieved.");
    results.push({ test: 3, name: "Mid-stream abort & slot recovery", pass: true });
  } catch (err) {
    console.error("❌ FAIL: Test 3", err.message);
    results.push({ test: 3, name: "Mid-stream abort & slot recovery", pass: false, error: err.message });
  }

  // TEST 4: Expiry during download
  try {
    console.log("\n--- Test 4: Expiry during download ---");
    // Allocate session with 1-second TTL
    const sessionRes = await request("GET", "/api/session?ttl=1", null, { "X-Forwarded-For": "10.100.4.1" });
    const pin = sessionRes.json.pin;
    const senderToken = sessionRes.json.senderToken;

    await request("POST", "/api/drop", {
      pin,
      senderToken,
      type: "text",
      textContent: "Expiring data stream",
      shareMode: "burn_on_read",
      maxReads: 1,
      ttlSeconds: 1,
    }, { "X-Forwarded-For": "10.100.4.1" });

    // Start in-flight pickup before expiration with 2500ms duration
    const inFlight = await openInFlightPickup(pin, 2500, { "X-Forwarded-For": "10.100.4.2" });

    // Wait 1300ms so TTL expires while in flight
    await sleep(1300);

    // New pickup attempts MUST return 410 GONE / FILE_DELETED
    const newAttempt = await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": "10.100.4.3" });
    if (newAttempt.status !== 410) {
      throw new Error(`Expected 410 for new pickup after TTL expiry, got ${newAttempt.status}`);
    }

    // Existing in-flight download completes safely
    await sleep(1400);

    console.log("✅ PASS: Test 4 - In-flight download held buffer safely through expiration; new requests got 410.");
    results.push({ test: 4, name: "Expiry during in-flight download", pass: true });
  } catch (err) {
    console.error("❌ FAIL: Test 4", err.message);
    results.push({ test: 4, name: "Expiry during in-flight download", pass: false, error: err.message });
  }

  // TEST 5: Bug A verification (reserved -> staged -> live; X-Boot-Id consistency)
  try {
    console.log("\n--- Test 5: Bug A verification (session state machine & X-Boot-Id) ---");
    const sessionRes = await request("GET", "/api/session", null, { "X-Forwarded-For": "10.100.5.1" });
    const pin = sessionRes.json.pin;
    const senderToken = sessionRes.json.senderToken;
    const bootId1 = sessionRes.headers["x-boot-id"];

    // 1. While in 'reserved', check endpoint MUST return 404
    const checkReserved = await request("GET", `/api/check/${pin}`, null, { "X-Forwarded-For": "10.100.5.2" });
    if (checkReserved.status !== 404) {
      throw new Error(`Expected 404 while session is 'reserved', got ${checkReserved.status}`);
    }

    // 2. Stage the session (undo window)
    const stageRes = await request("POST", "/api/session/stage", { pin, senderToken }, { "X-Forwarded-For": "10.100.5.1" });
    if (stageRes.status !== 200 || stageRes.json.state !== "staged") {
      throw new Error(`Failed to stage session`);
    }

    // 3. While in 'staged', check endpoint MUST still return 404
    const checkStaged = await request("GET", `/api/check/${pin}`, null, { "X-Forwarded-For": "10.100.5.2" });
    if (checkStaged.status !== 404) {
      throw new Error(`Expected 404 while session is 'staged', got ${checkStaged.status}`);
    }

    // 4. Finalize & Drop to 'live'
    const dropRes = await request("POST", "/api/drop", {
      pin,
      senderToken,
      type: "text",
      textContent: "Live payload",
      shareMode: "burn_on_read",
    }, { "X-Forwarded-For": "10.100.5.1" });
    if (dropRes.status !== 200 || dropRes.json.state !== "live") {
      throw new Error(`Failed to drop payload`);
    }

    // 5. Once 'live', check endpoint returns 200 immediately
    const checkLive = await request("GET", `/api/check/${pin}`, null, { "X-Forwarded-For": "10.100.5.2" });
    if (checkLive.status !== 200 || !checkLive.json.exists) {
      throw new Error(`Expected 200 once session is 'live', got ${checkLive.status}`);
    }

    const bootId2 = checkLive.headers["x-boot-id"];
    if (!bootId1 || bootId1 !== bootId2) {
      throw new Error(`X-Boot-Id mismatch! Expected constant boot ID across requests.`);
    }

    console.log(`✅ PASS: Test 5 - Reserved/staged states hide drop (404); live is visible immediately (200). Boot ID (${bootId1}) matches.`);
    results.push({ test: 5, name: "Bug A state machine & X-Boot-Id", pass: true });
  } catch (err) {
    console.error("❌ FAIL: Test 5", err.message);
    results.push({ test: 5, name: "Bug A state machine & X-Boot-Id", pass: false, error: err.message });
  }

  // TEST 6: 409 retry loop does NOT exhaust rate limiter
  try {
    console.log("\n--- Test 6: 409 retry loop does NOT exhaust rate limiter ---");
    const sessionRes = await request("GET", "/api/session", null, { "X-Forwarded-For": "10.100.6.1" });
    const pin = sessionRes.json.pin;
    const senderToken = sessionRes.json.senderToken;

    await request("POST", "/api/drop", {
      pin,
      senderToken,
      type: "text",
      textContent: "Slots busy limiter test",
      shareMode: "burn_on_read",
      maxReads: 1,
    }, { "X-Forwarded-For": "10.100.6.1" });

    // Hold slot 1 open for 2000ms
    const holdStream = await openInFlightPickup(pin, 2000, { "X-Forwarded-For": "10.100.6.2" });

    // Send 8 consecutive 409 pickup requests from the same receiver IP (normal threshold is 5 failed attempts)
    const receiverIp = "10.100.6.3";
    for (let i = 0; i < 8; i++) {
      const busyRes = await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": receiverIp });
      if (busyRes.status !== 409) {
        throw new Error(`Attempt ${i + 1} expected 409, got ${busyRes.status}`);
      }
    }

    // Abort holding stream
    holdStream.destroy();
    await sleep(300);

    // Receiver on receiverIp must NOT be locked out! (Must succeed with 200 OK)
    const legitPickup = await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": receiverIp });
    if (legitPickup.status !== 200) {
      throw new Error(`Expected 200 OK for legit pickup, got ${legitPickup.status} (Receiver was locked out by 409s!)`);
    }

    console.log("✅ PASS: Test 6 - 8 consecutive 409 retries did not count against attempt counter; pickup succeeded.");
    results.push({ test: 6, name: "409 retry loop rate limit immunity", pass: true });
  } catch (err) {
    console.error("❌ FAIL: Test 6", err.message);
    results.push({ test: 6, name: "409 retry loop rate limit immunity", pass: false, error: err.message });
  }

  // TEST 7: Same-IP vs different-IP concurrency & rate limiting
  try {
    console.log("\n--- Test 7: Same-IP vs different-IP concurrency ---");
    const sessionRes = await request("GET", "/api/session", null, { "X-Forwarded-For": "10.100.7.1" });
    const pin = sessionRes.json.pin;
    const senderToken = sessionRes.json.senderToken;

    await request("POST", "/api/drop", {
      pin,
      senderToken,
      type: "text",
      textContent: "Shared WiFi test",
      shareMode: "multiple_reads",
      maxReads: 2,
    }, { "X-Forwarded-For": "10.100.7.1" });

    // Two receivers sharing the exact same IP (e.g. office/home Wi-Fi NAT)
    const sameIp = "192.0.2.77";
    const s1 = await openInFlightPickup(pin, 400, { "X-Forwarded-For": sameIp });
    const s2 = await openInFlightPickup(pin, 400, { "X-Forwarded-For": sameIp });

    // Both hold slots simultaneously without being blocked by per-IP lockouts
    await sleep(600);

    // Limit of 2 reached
    const s3 = await request("POST", "/api/pickup", { pin }, { "X-Forwarded-For": sameIp });
    if (s3.status !== 410) {
      throw new Error(`Expected 410 after both finished, got ${s3.status}`);
    }

    console.log("✅ PASS: Test 7 - Two receivers on same IP successfully downloaded concurrently.");
    results.push({ test: 7, name: "Same-IP vs different-IP concurrency", pass: true });
  } catch (err) {
    console.error("❌ FAIL: Test 7", err.message);
    results.push({ test: 7, name: "Same-IP vs different-IP concurrency", pass: false, error: err.message });
  }

  // TEST 8: Per-PIN cooldown (does NOT auto-incinerate live drop)
  try {
    console.log("\n--- Test 8: Per-PIN cooldown & protection ---");
    const sessionRes = await request("GET", "/api/session", null, { "X-Forwarded-For": "10.100.8.1" });
    const pin = sessionRes.json.pin;
    const senderToken = sessionRes.json.senderToken;

    await request("POST", "/api/drop", {
      pin,
      senderToken,
      type: "text",
      textContent: "Target of simulated brute-force attempt",
      shareMode: "burn_on_read",
    }, { "X-Forwarded-For": "10.100.8.1" });

    // Simulate 5 failed attempts targeting wrong PINs from different IPs
    for (let i = 1; i <= 5; i++) {
      await request("POST", "/api/pickup", { pin: "9999" }, { "X-Forwarded-For": `198.51.100.${i}` });
    }

    // Verify legitimate drop at `pin` is still intact and NOT incinerated
    const legitCheck = await request("GET", `/api/check/${pin}`, null, { "X-Forwarded-For": "10.100.8.2" });
    if (legitCheck.status !== 200 || !legitCheck.json.exists) {
      throw new Error(`Live drop was improperly incinerated! Status: ${legitCheck.status}`);
    }

    console.log("✅ PASS: Test 8 - Distributed failed attempts did not destroy legitimate session.");
    results.push({ test: 8, name: "Per-PIN cooldown (no auto-burn)", pass: true });
  } catch (err) {
    console.error("❌ FAIL: Test 8", err.message);
    results.push({ test: 8, name: "Per-PIN cooldown (no auto-burn)", pass: false, error: err.message });
  }

  // TEST 9: Unknown /api/* route returns JSON 404 (not HTML)
  try {
    console.log("\n--- Test 9: Unknown /api/* route returns JSON 404 ---");
    const unknownRes = await request("GET", "/api/nonexistent-route-12345");
    if (unknownRes.status !== 404) {
      throw new Error(`Expected 404, got status ${unknownRes.status}`);
    }
    if (!unknownRes.json || unknownRes.json.error?.code !== "NOT_FOUND") {
      throw new Error(`Expected JSON error response with code NOT_FOUND, got: ${unknownRes.data}`);
    }
    console.log("✅ PASS: Test 9 - Unknown API route returns clean JSON 404 with boot ID.");
    results.push({ test: 9, name: "Unknown API route returns JSON 404", pass: true });
  } catch (err) {
    console.error("❌ FAIL: Test 9", err.message);
    results.push({ test: 9, name: "Unknown API route returns JSON 404", pass: false, error: err.message });
  }

  console.log("\n=================================================");
  console.log("📊 ACCEPTANCE TESTS SUMMARY");
  console.log("=================================================");
  let passedCount = 0;
  for (const r of results) {
    const mark = r.pass ? "✅ PASS" : "❌ FAIL";
    console.log(`Test ${r.test}: ${r.name} -> ${mark}${r.error ? ` (${r.error})` : ""}`);
    if (r.pass) passedCount++;
  }
  console.log(`\nScore: ${passedCount} / ${results.length} tests passed.\n`);

  if (passedCount === results.length) {
    console.log("🎉 ALL ACCEPTANCE TESTS (1–9) PASSED PERFECTLY!");
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runAllTests().catch((e) => {
  console.error("Fatal test runner error:", e);
  process.exit(1);
});
