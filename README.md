# 🔥 Burner Room

> **Zero-Trace, Zero-Knowledge Ephemeral File & Text Sharing Across Devices**

Burner Room is a high-security, privacy-focused temporary transfer tool. Share sensitive text snippets, passwords, API tokens, or binary files across phones, laptops, and browsers using disposable 4-digit PINs, client-side AES-GCM-256 encryption, customizable auto-purge timers, and strict burn-on-read self-destruction.

---

## ⚡ Key Capabilities & Security Controls

- **🔐 Client-Side Zero-Knowledge Encryption**: Payloads are encrypted with 256-bit AES-GCM in browser RAM; encryption keys reside exclusively in the URL hash fragment (`#key=...`) and are never sent over HTTP to the server.
- **🛡️ PIN Brute-Force Rate Limiting & Lockout**: Limits failed attempts to 5 per IP with a 10-minute automated lockout (`HTTP 429`) and live countdown timer.
- **🔑 Cryptographic Sender Ownership Tokens**: Destructive actions (`/api/burn`) and real-time event streams require a cryptographically verified `senderToken` issued at session creation.
- **🤖 Bot Link-Preview Auto-Burn Mitigation**: Deep-link URLs (`/?pin=XXXX`) pre-fill PIN inputs and show safe metadata previews, but strictly gate payload retrieval and destruction behind an explicit human click.
- **⏱️ Customizable TTL (1m to 60m)**: Choose presets (`5m`, `10m`, `15m`, `30m`, `1h`) or set exact minute intervals before automated memory zeroization.
- **🔒 Burn-on-Read or Multi-Share**: Incinerate payloads immediately upon first pickup or permit multi-device retrieval with optional maximum download caps.
- **⚡ Live Server-Sent Events (SSE)**: Senders receive instant real-time browser alerts the moment their recipient retrieves or incinerates the payload.
- **📁 50MB Files & Monospace Text Buffer**: Drag-and-drop any file format or paste confidential credentials directly.
- **🧠 Zero-Persistence RAM Buffers**: Ephemeral in-memory storage with a 1.5GB total memory safety ceiling.
- **🎯 Dynamic Spotlight Onboarding**: Interactive guided tour highlighting key controls with smooth spring physics.

---

## 🛠️ Tech Stack

- **Frontend**: React 18, TypeScript, Tailwind CSS, Motion (`motion/react`), Lucide React
- **Cryptography**: Web Crypto API (SubtleCrypto AES-GCM 256-bit)
- **Backend / API**: Express 4, TypeScript, Node.js (`server.ts` & `/api/index.ts`)
- **Build Tools**: Vite, esbuild, TypeScript Compiler (`tsc`)
- **Deployment**: Vercel Serverless Function configuration (`vercel.json`) & Cloud Run / Docker standalone server

---

## 🚀 Getting Started

### Prerequisites
- Node.js 18+ (or Bun / Yarn / npm)

### Installation

```bash
# Clone repository
git clone https://github.com/your-username/burner-room.git
cd burner-room

# Install dependencies
npm install
```

### Running Locally

```bash
# Start full-stack dev server (Express + Vite) on port 3000
npm run dev
```

Visit `http://localhost:3000` in your browser.

---

## 📦 Scripts

| Command | Description |
|---|---|
| `npm run dev` | Runs the full-stack development server with live reload |
| `npm run build` | Compiles the frontend via Vite and bundles `server.ts` to `dist/server.cjs` via esbuild |
| `npm run start` | Runs the compiled production server (`node dist/server.cjs`) |
| `npm run lint` | Runs TypeScript typechecks (`tsc --noEmit`) |

---

## 📖 How It Works

1. **Sender Opens Drop View**: An ephemeral 4-digit PIN is generated instantly (e.g. `4921`) along with a sender ownership token.
2. **Configure & Upload**:
   - Drag in a file (up to 50MB) or paste confidential text.
   - Choose **E2E Encryption** (Zero-Knowledge AES-GCM-256).
   - Select a TTL duration (e.g., 10 minutes).
   - Choose **1-Time Read** or **Multi-Share** (with optional max-reads cap).
3. **Recipient Enters PIN**: Recipient opens Burner Room on any device, enters the PIN (or scans the QR code / clicks the 1-click link `/?pin=4921#key=...`).
4. **Explicit Unlock & Incineration**: The recipient reviews the metadata and taps **"Unlock & Incinerate"**. The client decrypts the payload locally and the server wipes the memory buffer permanently.

---

## 📚 Complete Architecture Documentation

For a detailed breakdown of all security tiers, encryption specifications, and verification testing commands, see [FEATURES.md](./FEATURES.md).

---

## 📄 License

MIT License. Designed with zero tracking, zero logs, and zero persistence.
