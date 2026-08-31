# 🔥 Burner Room

> **Zero-Trace, Ephemeral File & Text Sharing Across Devices**

Burner Room is a minimalist, privacy-focused temporary transfer tool. Share sensitive text snippets, passwords, API tokens, or files across phones, laptops, and browsers using a disposable 4-digit PIN, customizable auto-purge timers, and strict burn-on-read self-destruction.

---

## ⚡ Quick Highlights

- **🔑 4-Digit Numeric PINs**: No user accounts, registration, or contact sharing required.
- **⏱️ Customizable TTL**: Choose presets (`5m`, `10m`, `15m`, `30m`, `1h`) or set exact minute intervals (1–60 mins).
- **🔒 Burn-on-Read or Multi-Share**: Incinerate payloads immediately upon first pickup or permit multi-device retrieval before TTL expiry.
- **📁 50MB Files & 10k Text Characters**: Drag-and-drop any file format or paste code/tokens directly.
- **🧠 Zero-Persistence RAM Buffers**: Payloads exist solely in temporary memory and are never written to disk or databases.
- **🎯 Dynamic Spotlight Onboarding**: Interactive guided tour that highlights each key interface control with smooth spring motion.
- **🚀 Vercel & Container Ready**: Dual-support for standalone Express/Node servers and Vercel serverless functions.

---

## 🛠️ Tech Stack

- **Frontend**: React 18, TypeScript, Tailwind CSS, Motion (`motion/react`), Lucide React
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

1. **Sender Opens Drop View**: An ephemeral 4-digit PIN is generated instantly (e.g. `4921`).
2. **Configure & Upload**:
   - Drag in a file (up to 50MB) or paste text (up to 10,000 chars).
   - Select a TTL duration (e.g., 10 minutes).
   - Choose **1-Time Read** (self-destruct on first open) or **Multi-Share**.
3. **Recipient Enters PIN**: Recipient visits Burner Room on any device, switches to **Pickup**, and enters the 4-digit PIN (or opens direct URL `/?pin=4921`).
4. **Instant Destruction**: Once retrieved in 1-time mode (or once the TTL countdown hits 0:00), the memory buffer is wiped permanently.

---

## 📚 Documentation

For a comprehensive technical breakdown of all system capabilities, security guarantees, and API endpoints, see [FEATURES.md](./FEATURES.md).

---

## 📄 License

MIT License. Designed with zero tracking, zero logs, and zero persistence.
