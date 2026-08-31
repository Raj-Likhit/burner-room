# 🔥 Burner Room — Technical Feature Specification & Architecture Guide

Burner Room is a secure, zero-trace, ephemeral file and text sharing platform designed for cross-device payloads with zero persistence, strict memory auto-purging, customizable time-to-live (TTL), and irreversible self-destruction policies.

---

## Table of Contents

1. [Architectural Overview](#1-architectural-overview)
2. [Core Feature Breakdown](#2-core-feature-breakdown)
   - [4-Digit Ephemeral Session Keys](#21-4-digit-ephemeral-session-keys)
   - [Universal Payload Ingestion (File & Text)](#22-universal-payload-ingestion-file--text)
   - [Customizable TTL Auto-Purge Engine](#23-customizable-ttl-auto-purge-engine)
   - [Granular Share Policies (Burn-on-Read vs Multi-Share)](#24-granular-share-policies-burn-on-read-vs-multi-share)
   - [Recipient Pickup & Decoupled Retrieval](#25-recipient-pickup--decoupled-retrieval)
   - [Instant Sender Manual Incineration](#26-instant-sender-manual-incineration)
   - [Dynamic Spotlight Onboarding Tour](#27-dynamic-spotlight-onboarding-tour)
   - [Responsive Motion & Visual Design System](#28-responsive-motion--visual-design-system)
3. [Security & Zero-Trace Guarantee](#3-security--zero-trace-guarantee)
4. [API Specification & Protocols](#4-api-specification--protocols)
5. [Vercel & Full-Stack Deployment Architecture](#5-vercel--full-stack-deployment-architecture)

---

## 1. Architectural Overview

Burner Room operates on a **RAM-only buffer model**. Unlike traditional cloud storage or file lockers that write payloads to relational databases, disk volumes, or object buckets (e.g. S3 / GCS), Burner Room holds payloads exclusively within in-memory structures that are tied to strict TTL expirations and instant eviction triggers.

### System Diagram

```
[ Sender Client ] 
       │
       ▼ (POST /api/drop + 4-Digit PIN + TTL + Share Policy)
┌────────────────────────────────────────────────────────┐
│               In-Memory Ephemeral RAM Buffer           │
│  - Non-colliding PIN Registry                          │
│  - Active TTL Expiration Timers (1m – 60m)             │
│  - Real-time Read-Counter & Destruction State Engine   │
└────────────────────────────────────────────────────────┘
       ▲
       │ (POST /api/pickup with matching PIN)
[ Recipient Device(s) ] ────► [ Instant Memory Eviction / Zeroization ]
```

---

## 2. Core Feature Breakdown

### 2.1. 4-Digit Ephemeral Session Keys
- **Collision-Free Generation**: Generates a pseudo-random, non-colliding 4-digit numeric PIN (`1000`–`9999`) with active collision detection against currently allocated sessions.
- **One-Click Clipboard Synchronization**: Clicking the PIN display instantly copies the access code with haptic/visual feedback.
- **On-Demand Key Rotation**: Senders can re-roll their PIN prior to payload upload at any time via the refresh trigger.
- **Direct Pairing URL Support**: Recipients can navigate directly via query parameter (e.g. `/?pin=4921`) to automatically prefill and focus the pickup interface.

### 2.2. Universal Payload Ingestion (File & Text)
- **Binary File Drops**:
  - Accepts any MIME type (`.pdf`, `.zip`, `.png`, `.jpg`, `.mp4`, binaries, documents, etc.).
  - Maximum payload size: **50 MB** per drop.
  - Client-side validation prevents oversized payloads before transmission.
- **Secure Text Snippets**:
  - Up to **10,000 characters** for API keys, passwords, authentication tokens, or sensitive raw text.
  - Formatted monospace editor with live character counters and clear triggers.
- **Dual Drag-and-Drop & File Picker**: Integrated React Dropzone supporting both drag-over interactions and native system file dialogs.

### 2.3. Customizable TTL Auto-Purge Engine
- **Flexible Lifespans**:
  - **Quick Presets**: Instant selection for `5m`, `10m`, `15m`, `30m`, and `1h`.
  - **Precision Minute Slider**: Dynamic range slider allowing customized TTL from **1 minute to 60 minutes**.
- **Real-Time Visual Countdown**:
  - Synchronized high-frequency countdown timer displaying remaining minutes, seconds, and milliseconds.
  - Animated progress bar transitioning from white to alert crimson as time elapses.
- **Hard Eviction at T-Zero**: Once the TTL expires, the server-side memory entry is immediately purged. Any subsequent pickup request returns `HTTP 410 Gone`.

### 2.4. Granular Share Policies
- **1-Time Read (`burn_on_read`)**:
  - Strict self-destruct mode.
  - The payload is delivered to the first recipient and purged from server RAM immediately upon pickup.
  - Subsequent access attempts by any device fail permanently.
- **Multi-Share (`multiple_reads`)**:
  - Allows multiple devices or team members to retrieve the payload as long as the TTL has not expired.
  - Maintains an active download count displayed in the recipient UI.
  - Memory is destroyed upon TTL expiration or manual sender incineration.

### 2.5. Recipient Pickup & Decoupled Retrieval
- **Pre-Flight Inspection (`GET /api/check/:pin`)**:
  - Checks if a valid payload exists and returns payload metadata (MIME type, file size, share mode, expiration time) without consuming a 1-time read token.
- **Decoupled Pickup (`POST /api/pickup`)**:
  - Consumes or retrieves the payload.
  - Text payloads feature a one-click copy button and monospace viewer.
  - File payloads trigger a direct browser blob download with original filenames and extensions preserved.
- **Visual Destruction Confirmation**:
  - Displays instant incineration feedback confirming zero traces remain on the server.

### 2.6. Instant Sender Manual Incineration
- Senders maintain an emergency **Burn Now** trigger on active uploads.
- Invoking manual burn immediately purges the payload from RAM regardless of remaining TTL.

### 2.7. Dynamic Spotlight Onboarding Tour
- **Visual Element Tracking**:
  - Uses dynamic SVG cutout masks and spring physics to dim the interface while illuminating the active control.
  - Animated neon crimson framing reticle with corner alignment marks tracks bounding boxes across window resizes and scrolling.
- **5-Step Interactive Guided Tour**:
  1. **Session Access Key**: Introduces the 4-digit PIN, clipboard copying, and key rotation.
  2. **Zero-Trace Dropzone**: Highlights file drag-and-drop and text snippet switching.
  3. **Auto-Destruct TTL**: Demonstrates the 1m–60m duration presets and custom slider.
  4. **Share Policy Switcher**: Explains 1-Time Read vs Multi-Share options.
  5. **Auto-Purge Clock**: Highlights the real-time countdown progress bar.
- **User Control**:
  - Skippable at any step via `Skip Tour`, backdrop click, or `Escape` key.
  - Full keyboard navigation (`ArrowRight`/`Enter` for Next, `ArrowLeft` for Back).
  - Can be reopened at any time via the **Guide** button in the navigation header.

### 2.8. Responsive Motion & Visual Design System
- **Dark Minimalist Aesthetic**: High-contrast `#0D0D0D` dark theme with `#FF3B30` accents.
- **Spring-Loaded Transitions**: Fluid component entrance and exit states built with `motion/react`.
- **Responsive Layout**: Adapts cleanly from mobile screens (with minimum 44px touch targets) to ultra-wide desktop monitors.

---

## 3. Security & Zero-Trace Guarantee

1. **No Database Writes**: Payloads are never stored in SQLite, PostgreSQL, MongoDB, Redis, or local disk caches.
2. **RAM Zeroization**: Upon pickup (in 1-time mode), TTL expiry, or manual burn, the memory map key is deleted and dereferenced for garbage collection.
3. **No User Accounts or Tracking**: No cookies, tracking pixels, persistent device fingerprinting, or login requirements.
4. **Encrypted In-Transit**: All payloads are delivered over standard TLS/HTTPS.

---

## 4. API Specification & Protocols

### 1. `GET /api/session?ttl=:seconds`
Generates a fresh 4-digit PIN with optional TTL configuration.
- **Query Params**: `ttl` (optional, integer, 60–3600, default: 600)
- **Response**:
  ```json
  {
    "pin": "4921",
    "createdAt": 1725100000000,
    "expiresAt": 1725100600000,
    "ttlSeconds": 600
  }
  ```

### 2. `POST /api/drop`
Uploads a text or file payload into the ephemeral RAM buffer.
- **Request Body**:
  ```json
  {
    "pin": "4921",
    "type": "text",
    "shareMode": "burn_on_read",
    "ttlSeconds": 600,
    "textContent": "secret-api-token-example"
  }
  ```
- **Response**:
  ```json
  {
    "success": true,
    "message": "Payload uploaded successfully. Ready for pickup.",
    "pin": "4921",
    "shareMode": "burn_on_read",
    "expiresAt": 1725100600000,
    "ttlSeconds": 600
  }
  ```

### 3. `GET /api/check/:pin`
Non-destructive status check for a PIN.
- **Response (200 OK)**:
  ```json
  {
    "exists": true,
    "type": "file",
    "shareMode": "burn_on_read",
    "readCount": 0,
    "expiresAt": 1725100600000,
    "remainingSeconds": 584,
    "fileMeta": {
      "name": "document.pdf",
      "size": 1048576,
      "type": "application/pdf"
    }
  }
  ```

### 4. `POST /api/pickup`
Retrieves payload and executes burn policy if configured as `burn_on_read`.
- **Request Body**: `{ "pin": "4921" }`
- **Response**:
  ```json
  {
    "success": true,
    "isBurned": true,
    "shareMode": "burn_on_read",
    "readCount": 1,
    "burnedAt": 1725100050000,
    "payload": {
      "pin": "4921",
      "type": "text",
      "textContent": "secret-api-token-example",
      "createdAt": 1725100000000,
      "expiresAt": 1725100600000,
      "ttlSeconds": 600,
      "status": "retrieved"
    }
  }
  ```

### 5. `POST /api/burn`
Manually destroys an active payload ahead of TTL expiration.
- **Request Body**: `{ "pin": "4921" }`
- **Response**: `{ "success": true, "message": "Payload destroyed immediately." }`

### 6. `GET /api/health`
Health check and active buffer telemetry.
- **Response**: `{ "status": "online", "activeSessions": 2, "system": "Zero-Persistence / Read-Once" }`

---

## 5. Vercel & Full-Stack Deployment Architecture

The application is architected for dual-mode deployment:

1. **Standalone Full-Stack Server (`server.ts`)**:
   - Express server bound to port `3000` with integrated Vite middleware in development and static asset serving in production.
   - Bundled to `dist/server.cjs` via `esbuild` for Node / container hosting.
2. **Vercel Serverless Function (`/api/index.ts`) & `vercel.json`**:
   - Clean export for Vercel Edge/Serverless deployments with warm instance memory maps.
   - Route rewrites send `/api/*` to `/api/index.ts` and all client requests to `index.html`.
