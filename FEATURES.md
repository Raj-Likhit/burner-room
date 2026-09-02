# 🔥 Burner Room — Complete Feature & Technical Architecture Guide

> **Burner Room** is an enterprise-grade, zero-trace, ephemeral file and text transfer platform engineered for secure cross-device payloads. It enforces client-side zero-knowledge AES-GCM-256 encryption, RAM-only ephemeral storage, global and per-IP brute-force rate-limiting, sender ownership tokens, pre-buffer RAM limits, per-IP quotas, customizable time-to-live (TTL) lifespans, granular self-destruction policies, and real-time Server-Sent Events (SSE) pickup alerts.

---

## 📑 Table of Contents

1. [Architectural Overview & Security Hardening](#1-architectural-overview--security-hardening)
2. [Tier 1 — Critical Security Controls](#2-tier-1--critical-security-controls)
   - [2.1. Dual-Layer Brute-Force Defense: Global PIN Cap + Per-IP Lockout](#21-dual-layer-brute-force-defense-global-pin-cap--per-ip-lockout)
   - [2.2. Decoupled `/api/check` vs `/api/pickup` Budgets (Bot Unfurl Protection)](#22-decoupled-apicheck-vs-apipickup-budgets-bot-unfurl-protection)
   - [2.3. Cryptographic Sender Ownership Verification (`/api/burn`)](#23-cryptographic-sender-ownership-verification-apiburn)
   - [2.4. Link Preview Auto-Burn Mitigation (Explicit Human Unlock)](#24-link-preview-auto-burn-mitigation-explicit-human-unlock)
   - [2.5. Filename & Path Traversal Sanitization](#25-filename--path-traversal-sanitization)
3. [Tier 2 — Enterprise Security & Resource Protection](#3-tier-2--enterprise-security--resource-protection)
   - [3.1. Pre-Buffer RAM Cap Enforcement (`Content-Length` Pre-Check)](#31-pre-buffer-ram-cap-enforcement-content-length-pre-check)
   - [3.2. Per-IP RAM Quota & Concurrent Active Drops Ceiling](#32-per-ip-ram-quota--concurrent-active-drops-ceiling)
   - [3.3. CSRF Protection for Mutating Endpoints](#33-csrf-protection-for-mutating-endpoints)
   - [3.4. Constant-Time PIN & Token Verification](#34-constant-time-pin--token-verification)
   - [3.5. Enterprise Security Headers (CSP, HSTS, X-Content-Type-Options)](#35-enterprise-security-headers-csp-hsts-x-content-type-options)
   - [3.6. Log Scrubbing & Zero-Data Telemetry](#36-log-scrubbing--zero-data-telemetry)
   - [3.7. SSE Connection Hygiene & Socket Cleanup](#37-sse-connection-hygiene--socket-cleanup)
4. [Tier 3 — Quality-of-Life & Resilience](#4-tier-3--quality-of-life--resilience)
   - [4.1. Sender-Side Reconnect via `sessionStorage`](#41-sender-side-reconnect-via-sessionstorage)
   - [4.2. Rich Error Cards & Lockout Countdowns](#42-rich-error-cards--lockout-countdowns)
   - [4.3. Chunked Upload & Decryption Progress Indicators](#43-chunked-upload--decryption-progress-indicators)
   - [4.4. Native Web Share API Integration](#44-native-web-share-api-integration)
   - [4.5. Live Real-Time Pickup Notifications (Server-Sent Events)](#45-live-real-time-pickup-notifications-server-sent-events)
   - [4.6. Accessibility (a11y) & Reduced Motion Support](#46-accessibility-a11y--reduced-motion-support)
5. [Tier 4 — Zero-Knowledge Cryptographic Architecture](#5-tier-4--zero-knowledge-cryptographic-architecture)
   - [5.1. Default-On Client-Side AES-GCM-256 End-to-End Encryption](#51-default-on-client-side-aes-gcm-256-end-to-end-encryption)
   - [5.2. Multi-Share Max-Reads Auto-Incineration](#52-multi-share-max-reads-auto-incineration)
   - [5.3. URL Fragment Key Architecture & Residual Risk Transparency](#53-url-fragment-key-architecture--residual-risk-transparency)
6. [Interactive Spotlight Guided Tour](#6-interactive-spotlight-guided-tour)
7. [API Protocol Specification](#7-api-protocol-specification)
8. [Verification & Testing Guide](#8-verification--testing-guide)

---

## 1. Architectural Overview & Security Hardening

Burner Room operates on a **zero-trace, zero-persistence model**. Payloads are encrypted client-side by default, held strictly in temporary RAM buffers, and permanently purged upon retrieval, manual burn, or TTL expiration.

```
                    ┌──────────────────────────────────────────────────────────┐
                    │               SENDER BROWSER (CLIENT)                    │
                    │  1. Generate 256-bit AES-GCM Key (Local RAM)             │
                    │  2. Encrypt Text / File with random 12-byte IV           │
                    │  3. Form URL with Key in Hash Fragment (#key=...)        │
                    │  4. Receive Cryptographic Sender Ownership Token         │
                    └────────────────────────────┬─────────────────────────────┘
                                                 │ HTTP POST /api/drop (Ciphertext only + X-Burner-Client)
                                                 ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   IN-MEMORY EPHEMERAL RAM STORE                                 │
│                                                                                                 │
│  [ PIN: "4921" ] ──► { Ciphertext, IV, SenderToken, Mode: "burn_on_read", TTL: 600s }            │
│  [ PIN: "8134" ] ──► { Ciphertext, IV, SenderToken, Mode: "multiple_reads", MaxReads: 5 }       │
│                                                                                                 │
│  • Memory Guard: Pre-checks Content-Length before body buffering (1.5 GB Global RAM Cap)        │
│  • Per-IP Quota: Max 150 MB and 3 concurrent active drops per IP                                │
│  • Dual-Layer Rate Limiting: 5 failed pickups/IP (10m lockout) + 10 global attempts auto-burn   │
│  • Decoupled Preview Checks: Generous 25 check budget for link unfurlers (Slack/Discord/bots)   │
│  • Constant-Time Comparison: Timing-attack resistant PIN and token verification                 │
│  • Auto-Purge Sweeper: Sweeps expired keys every 10 seconds + closes SSE sockets cleanly        │
└───────────────────────┬───────────────────────────────────────────┬─────────────────────────────┘
                        │                                           │
                        ▼ HTTP GET/HEAD /api/check/:pin             ▼ HTTP POST /api/pickup (Explicit Tap)
        ┌───────────────────────────────┐           ┌───────────────────────────────┐
        │       GATED PRE-FLIGHT        │           │       RECIPIENT PICKUP        │
        │  - File name & size metadata  │           │  - Ciphertext + IV returned   │
        │  - Read policy indicator      │           │  - Client decrypts with #key  │
        │  - Bot Link Crawlers DO NOT   │           │  - 1-Time payload incinerated │
        │    burn or destroy payload    │           │  - Sender notified via SSE    │
        └───────────────────────────────┘           └───────────────────────────────┘
```

---

## 2. Tier 1 — Critical Security Controls

### 2.1. Dual-Layer Brute-Force Defense: Global PIN Cap + Per-IP Lockout
- **Vulnerability Solved**: 
  1. *Single Attacker*: Enumerating 9,000 possible 4-digit PINs.
  2. *Distributed Attacker*: Rotating through botnets, proxies, or VPN exits to bypass per-IP limits.
- **Protection**:
  - **Per-IP Rate Limit**: Tracks failed pickup attempts per client IP. 5 failed attempts trigger a **10-minute lockout** (`HTTP 429 Too Many Requests`, `Retry-After: 600`).
  - **Global Per-PIN Cap**: Any single PIN can only be attempted **10 times total across all IPs combined**.
  - If a PIN exceeds 10 failed attempts globally, the server **immediately auto-incinerates** the payload from memory, notifies the sender via SSE (`reason: "global_bruteforce_limit"`), and registers the PIN in the burned store so subsequent requests return `HTTP 410 Gone`.

### 2.2. Decoupled `/api/check` vs `/api/pickup` Budgets (Bot Unfurl Protection)
- **Vulnerability Solved**: If a drop link is posted in a channel where multiple chat platforms unfurl previews (e.g. Slack + Discord + iMessage bots simultaneously), shared rate limits could exhaust the recipient's attempt budget before they even open the page.
- **Protection**:
  - `/api/check/:pin` is idempotent and non-destructive.
  - Valid checks **do not** increment the failure counter or decrement attempt budgets.
  - Invalid checks are tracked in a dedicated `ipCheckRateLimits` table with a generous budget of **25 attempts per window**.
  - `/api/pickup` remains strictly guarded by the 5-attempt threshold.
  - `HEAD /api/check/:pin` and `HEAD /?pin=XXXX` requests are supported and completely non-destructive.

### 2.3. Cryptographic Sender Ownership Verification (`/api/burn`)
- **Vulnerability Solved**: Anyone knowing or guessing a PIN could delete someone else's active payload.
- **Protection**:
  - Generated session creates a high-entropy 32-character hexadecimal token (`crypto.randomBytes(16).toString('hex')`).
  - The token is held exclusively in sender state / `sessionStorage`.
  - `/api/burn` verifies the token via constant-time comparison. Unauthorized requests return `HTTP 403 Forbidden`.

### 2.4. Link Preview Auto-Burn Mitigation (Explicit Human Unlock)
- **Vulnerability Solved**: Chat preview crawlers issuing background GETs would destroy read-once payloads before human recipients opened them.
- **Protection**:
  - Opening `/?pin=XXXX` pre-fills the PIN and calls non-destructive `GET /api/check/:pin` for metadata display only.
  - Payload retrieval and incineration is gated behind an explicit human click on the **"Unlock & Incinerate"** button.

### 2.5. Filename & Path Traversal Sanitization
- **Vulnerability Solved**: Path traversal (`../../etc/passwd`), null bytes, or control characters embedded in uploaded file names.
- **Protection**:
  - Sanitization on both client and server:
    ```ts
    name.replace(/[\x00-\x1F\x7F]/g, "").replace(/[/\\]/g, "_").replace(/\.\./g, "_").trim()
    ```
  - Downloads include explicit `Content-Disposition: attachment; filename="..."` headers.

---

## 3. Tier 2 — Enterprise Security & Resource Protection

### 3.1. Pre-Buffer RAM Cap Enforcement (`Content-Length` Pre-Check)
- **Vulnerability Solved**: An attacker uploading a massive file could crash the Node server via Out-of-Memory (OOM) before body parsers could check size limits.
- **Protection**:
  - Early Express middleware inspects the HTTP `Content-Length` header **before** body parsing:
    - Requests exceeding 55MB are immediately rejected with `HTTP 413 Payload Too Large`.
    - If `currentTotalRamBytes + contentLength > 1.5 GB`, the request is rejected with `HTTP 507 Insufficient Storage` without buffering a single byte into memory.

### 3.2. Per-IP RAM Quota & Concurrent Active Drops Ceiling
- **Vulnerability Solved**: A single client exhausting the global 1.5GB RAM capacity by creating numerous large uploads.
- **Protection**:
  - **Per-IP RAM Quota**: Max **150 MB** active allocated memory per IP.
  - **Active Sessions Ceiling**: Max **3 concurrent active drops** per IP.
  - Quotas are dynamically tracked and instantly reclaimed when payloads burn, expire, or are manually incinerated.

### 3.3. CSRF Protection for Mutating Endpoints
- **Protection**:
  - All mutating endpoints (`POST /api/drop`, `POST /api/pickup`, `POST /api/burn`) verify custom headers (`X-Burner-Client: v1` or `X-Requested-With: XMLHttpRequest`) and validate `Sec-Fetch-Site`.
  - Simple cross-origin HTML form submissions cannot forge custom headers, preventing CSRF exploitation.

### 3.4. Constant-Time PIN & Token Verification
- String comparisons for PINs and sender tokens use Node's `crypto.timingSafeEqual`.
- Buffers of unequal length execute a dummy constant-time operation to prevent side-channel timing leaks on string lengths.

### 3.5. Enterprise Security Headers
- `Content-Security-Policy`: Restricts scripts, styles, images, and frame ancestors.
- `X-Content-Type-Options: nosniff`: Prevents MIME-type sniffing.
- `X-Frame-Options: SAMEORIGIN`: Prevents clickjacking.
- `Strict-Transport-Security: max-age=31536000; includeSubDomains`: Enforces HTTPS.
- `Referrer-Policy: strict-origin-when-cross-origin`: Minimizes referrer leakage.

### 3.6. Log Scrubbing & Zero-Data Telemetry
- All server log statements mask PINs (`PIN: 49**`) and completely exclude payload text, file contents, and encryption keys.

### 3.7. SSE Connection Hygiene & Socket Cleanup
- When a payload is incinerated or expired, the server broadcasts a `type: "closed"` event and explicitly closes (`client.end()`) all attached Server-Sent Event sockets, clearing listeners and preventing connection leaks.

---

## 4. Tier 3 — Quality-of-Life & Resilience

### 4.1. Sender-Side Reconnect via `sessionStorage`
- Active session state (`pin`, `senderToken`, `expiresAt`, `uploadedFileName`, `shareMode`, `e2eKeyString`) is persisted in `sessionStorage`.
- Refreshing the sender's tab restores the Armed view and reconnects to live SSE events without losing ownership authority.

### 4.2. Rich Error Cards & Lockout Countdowns
- Visual error cards with distinct icons and guidance for:
  - **404 Not Found**: *"Invalid PIN (4 attempts remaining)"*
  - **410 Expired / Burned**: *"Payload has expired and was automatically incinerated."*
  - **429 Rate Limited**: Live ticker counting down remaining lockout seconds.
  - **Decryption Key Missing / Invalid**: Prompt to enter the Zero-Knowledge key.

### 4.3. Chunked Upload & Decryption Progress Indicators
- Animated progress bar showing upload arming and client-side decryption stages with percentage tracking.

### 4.4. Native Web Share API Integration
- One-touch mobile sharing via `navigator.share` on iOS and Android devices, pre-populating the direct link and PIN, with automatic fallback to clipboard copy.

### 4.5. Live Real-Time Pickup Notifications (Server-Sent Events)
- Endpoint: `GET /api/events/:pin?senderToken=...`
- When a recipient unlocks the payload, the server emits an SSE event directly to the sender's open browser tab:
  - *"🔥 Recipient retrieved payload! Session permanently burned."*
  - Live read counters increment automatically in multi-share mode.

### 4.6. Accessibility (a11y) & Reduced Motion Support
- Full keyboard focus management across the 4-box PIN input.
- ARIA live regions (`role="timer"`, `aria-label`) for the countdown and status indicators.
- Complies with `prefers-reduced-motion` media queries.

---

## 5. Tier 4 — Zero-Knowledge Cryptographic Architecture

### 5.1. Default-On Client-Side AES-GCM-256 End-to-End Encryption
- **Default State**: Enabled by default for all drops.
- **Workflow**:
  1. The browser generates a cryptographically strong 256-bit AES-GCM key using `window.crypto.subtle.generateKey`.
  2. The payload is encrypted client-side with a unique 12-byte initialization vector (IV).
  3. The raw key is encoded in Base64URL and appended **only** to the URL hash fragment (`#key=...`).
  4. The server receives and stores **only** ciphertext.
  5. The recipient's browser extracts `#key=...` from the fragment and performs local AES-GCM decryption.
- **Explicit Opt-Out**: Users can disable E2E for quick, non-confidential transfers, displaying an amber warning banner.

### 5.2. Multi-Share Max-Reads Auto-Incineration
- In Multi-Share mode, senders can specify an optional maximum download cap (e.g. 2, 5, or 10 reads).
- The server increments `readCount` on each pickup and automatically incinerates the payload from memory once `readCount >= maxReads`.

### 5.3. URL Fragment Key Architecture & Residual Risk Transparency
- **Security Property**: RFC 3986 guarantees that URL hash fragments (`#key=...`) are processed locally by browsers and are **never transmitted over the wire to server logs**.
- **Residual Risk Transparency**:
  - While server logs are immune, full URLs containing hash fragments remain in local browser history and device clipboard buffers until cleared.
  - The UI explicitly informs users in both sender and recipient views:
    > *"Privacy Note: Hash fragment keys (#key=...) never reach server logs, but remain in local browser history & clipboard on this device. Close this browser tab or clear history for maximum confidentiality."*

---

## 6. Interactive Spotlight Guided Tour
- Step-by-step visual onboarding highlighting:
  1. 4-Digit Ephemeral PIN
  2. Universal Drop & Text Buffer
  3. Customizable TTL (1m to 60m)
  4. 1-Time Read vs Multi-Share Policy
  5. Real-Time Auto-Purge Countdown
- Features SVG cutout masking, spring physics, keyboard navigation, and localStorage first-visit detection.

---

## 7. API Protocol Specification

### `GET /api/session?ttl=600`
Generates a new session PIN and issues a sender ownership token.

**Response**:
```json
{
  "pin": "4921",
  "senderToken": "7b8e1f0a2d3c4b5a6e7f8a9b0c1d2e3f",
  "createdAt": 1725184800000,
  "expiresAt": 1725185400000,
  "ttlSeconds": 600
}
```

---

### `POST /api/drop`
Arms an encrypted or unencrypted payload.

**Headers**:
- `Content-Type: application/json`
- `X-Burner-Client: v1`

**Request Body**:
```json
{
  "pin": "4921",
  "senderToken": "7b8e1f0a2d3c4b5a6e7f8a9b0c1d2e3f",
  "type": "file",
  "shareMode": "burn_on_read",
  "ttlSeconds": 600,
  "file": {
    "name": "financials.pdf",
    "size": 245000,
    "type": "application/pdf"
  },
  "encryptedBundle": {
    "ciphertext": "k3J...==",
    "iv": "x9L...==",
    "isEncrypted": true
  }
}
```

---

### `GET /api/check/:pin` and `HEAD /api/check/:pin`
Non-destructive metadata inspection (protected by rate-limiting).

**Headers**:
- `X-Burner-Client: v1`

**Response (200 OK)**:
```json
{
  "exists": true,
  "type": "file",
  "shareMode": "burn_on_read",
  "readCount": 0,
  "remainingSeconds": 580,
  "fileMeta": {
    "name": "financials.pdf",
    "size": 245000,
    "type": "application/pdf"
  },
  "isEncrypted": true
}
```

---

### `POST /api/pickup`
Retrieves and unlocks the payload. Destroys 1-time payloads.

**Headers**:
- `Content-Type: application/json`
- `X-Burner-Client: v1`

**Request Body**:
```json
{
  "pin": "4921"
}
```

**Response (200 OK)**:
```json
{
  "success": true,
  "isBurned": true,
  "shareMode": "burn_on_read",
  "readCount": 1,
  "payload": {
    "pin": "4921",
    "type": "file",
    "encryptedBundle": {
      "ciphertext": "k3J...==",
      "iv": "x9L...==",
      "isEncrypted": true
    }
  }
}
```

---

### `POST /api/burn`
Manually destroys a payload (requires sender ownership token).

**Headers**:
- `Content-Type: application/json`
- `X-Burner-Client: v1`
- `X-Sender-Token: 7b8e1f0a2d3c4b5a6e7f8a9b0c1d2e3f`

**Request Body**:
```json
{
  "pin": "4921",
  "senderToken": "7b8e1f0a2d3c4b5a6e7f8a9b0c1d2e3f"
}
```

---

### `GET /api/events/:pin?senderToken=...`
Server-Sent Events stream for live real-time pickup alerts.

---

## 8. Verification & Testing Guide

### 1. Verifying Brute-Force Rate Limiting & Lockout
Run failed check requests with an invalid PIN using `curl`:
```bash
for i in {1..26}; do
  curl -s -i "http://localhost:3000/api/check/0000" -H "X-Burner-Client: v1" | grep "HTTP/"
done
```
*Expected Result*: Returns `HTTP/1.1 429 Too Many Requests` with a `Retry-After: 600` header after exceeding the threshold.

### 2. Verifying `/api/burn` Sender Ownership Check
Attempt to burn an active session with an incorrect token:
```bash
curl -s -X POST http://localhost:3000/api/burn \
  -H "Content-Type: application/json" \
  -H "X-Burner-Client: v1" \
  -d '{"pin":"4921","senderToken":"invalid_token_123"}'
```
*Expected Result*: Returns `HTTP/1.1 403 Forbidden` (`{"error":"Forbidden: Invalid or missing sender ownership token."}`).

### 3. Verifying Non-Destructive `HEAD` Requests
Send a `HEAD` request to `/api/check/:pin`:
```bash
curl -I "http://localhost:3000/api/check/4921" -H "X-Burner-Client: v1"
```
*Expected Result*: Returns `HTTP/1.1 200 OK` without side effects; payload is not burned.

### 4. Verifying Global Distributed Attack Threshold
Simulate 10 failed attempts across multiple simulated IPs on the same PIN:
*Expected Result*: The 10th attempt auto-incinerates the payload, logs `global_bruteforce_limit`, notifies the sender via SSE, and returns `HTTP 410 Gone`.

### 5. Verifying CSRF Header Enforcement
Attempt a mutating `POST /api/drop` without security headers:
```bash
curl -s -X POST http://localhost:3000/api/drop \
  -H "Content-Type: application/json" \
  -d '{"pin":"4921","type":"text","textContent":"secret"}'
```
*Expected Result*: Returns `HTTP/1.1 403 Forbidden` (`"CSRF verification failed: Missing required X-Burner-Client or X-Requested-With security header."`).
