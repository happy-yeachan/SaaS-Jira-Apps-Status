# Atlassian Marketplace Status

Real-time service health dashboard for Jira & Confluence third-party apps — no login, no API token required.

![Next.js](https://img.shields.io/badge/Next.js-16.2-black?logo=next.js)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)
![Tailwind CSS](https://img.shields.io/badge/Tailwind-v4-38BDF8?logo=tailwindcss)

---

## Overview

Atlassian's own Jira instance has a status page, but the hundreds of third-party Marketplace apps that teams rely on — ScriptRunner, Tempo, Zephyr, draw.io, and many more — each publish their health on separate, vendor-hosted status pages. During an incident, engineers waste minutes hunting for the right URL.

This dashboard solves that: it aggregates live status from all your apps into one view, with heartbeat history, response times, and instant incident notifications — all without touching your Atlassian instance.

---

## Features

| Feature | Description |
|---|---|
| **Quick Setup** | One-click import of 21 popular apps grouped by category. Status URLs auto-detected per vendor. |
| **Marketplace Search** | Search any app by name. Status URL resolved server-side from a curated vendor map. |
| **Auto-discovery** | For vendors not in the static map, probes common patterns (`status.vendor.com`, `vendor.statuspage.io`, etc.) in parallel. |
| **Live Health Checks** | Calls vendor status APIs from the Next.js server (avoids CORS). Supports Atlassian Statuspage, Instatus, and Hund.io formats. |
| **Per-app Component Matching** | On unified vendor pages (e.g. Adaptavist hosts ScriptRunner, Bitbucket Connector, etc. on one page), fuzzy-matches the specific app's component to avoid false positives from other apps' outages. |
| **Heartbeat History** | Last 30 pings shown as colour-coded bars. Uptime % calculated per app. |
| **Auto-refresh** | Health checks run automatically every 5 minutes. |
| **Status Change Toasts** | Instant notifications when an app transitions between Operational / Degraded / Outage. |
| **Export** | Download your app list as JSON. |
| **Dark Mode** | Theme toggle with localStorage persistence and anti-flicker inline script. |
| **No backend, no database** | All state stored in `localStorage`. Works as a static site deployed to Vercel or any Next.js host. |

---

## Tech Stack

- **[Next.js 16](https://nextjs.org/)** (App Router, Turbopack) — server-side status API calls bypass CORS; client-only state for zero-DB architecture
- **[React 19](https://react.dev/)** — `memo`, `useCallback`, concurrent features
- **[TypeScript 5](https://www.typescriptlang.org/)** — strict mode throughout
- **[Tailwind CSS v4](https://tailwindcss.com/)** — utility-first styling with dark mode support
- **[base-ui](https://base-ui.com/)** — headless primitives (Tooltip, Dialog, etc.)
- **[shadcn/ui](https://ui.shadcn.com/)** — pre-built component shells (Table, Badge, Button)
- **[Lucide React](https://lucide.dev/)** — icon set
- **[cmdk](https://cmdk.paco.me/)** — command palette for app search

---

## Project Structure

```
src/
├── app/
│   ├── layout.tsx                  # Root layout — SEO metadata, anti-flicker dark mode script
│   ├── page.tsx                    # Single-page entry point
│   └── api/
│       ├── status/
│       │   └── route.ts            # POST — health check engine (Statuspage, Instatus, Hund parsers)
│       └── marketplace/
│           ├── search/
│           │   └── route.ts        # GET — Atlassian Marketplace search proxy + auto-discovery
│           └── popular/
│               └── route.ts        # GET — curated popular apps list with 1-hour in-memory cache
├── components/
│   ├── status-dashboard.tsx        # Main dashboard — state management, table, toasts, dialogs
│   ├── add-app-dialog.tsx          # Search-based single-app add flow
│   ├── quick-setup-dialog.tsx      # Bulk-add popular apps with checkboxes by category
│   ├── app-logo.tsx                # Logo with fallback to first-letter initials
│   ├── theme-toggle.tsx            # Dark/light toggle
│   └── ui/                         # shadcn/base-ui component shells
├── lib/
│   ├── status-discovery.ts         # Auto-discovery probe engine + vendor name normaliser
│   └── utils.ts                    # cn() Tailwind class merger
└── types/
    └── index.ts                    # Shared types + PRODUCT_RULES + VENDOR_STATUS_MAP
```

---

## How Status Resolution Works

Status URL resolution is a three-step pipeline, evaluated in priority order:

### Step 1 — PRODUCT_RULES (highest priority)

`src/types/index.ts` contains keyword rules for products that have their own status page distinct from their parent vendor. Rules are matched against the app name.

```ts
{ keywords: ["scriptrunner"], url: "https://status.connect.adaptavist.com/api/v2/summary.json" },
{ keywords: ["zephyr scale"],  url: "https://zephyr.status.smartbear.com/api/v2/summary.json" },
{ keywords: ["draw.io"],       url: "https://status.draw.io/index.json" },
```

Rules are evaluated in order. The first rule whose every keyword appears in the app name wins. This lets product-specific entries (e.g. "Zephyr Enterprise") take precedence over generic vendor entries ("SmartBear").

### Step 2 — VENDOR_STATUS_MAP (fallback)

If no product rule matches, the vendor name is looked up in the static map. The lookup uses substring matching so partial vendor names (e.g. "Tempo" within "Tempo Software Ltd") still resolve.

```ts
"tempo software":  "https://status.tempo.io/api/v2/summary.json",
"gitkraken":       "https://gij.gitkrakenstatus.com/api/v2/summary.json",
"lucid":           "https://status.lucid.co/api/v2/summary.json",
```

### Step 3 — Auto-discovery (for unknown vendors)

When neither map has an entry, `discoverStatusUrl()` in `src/lib/status-discovery.ts` probes common URL patterns in parallel:

```
status.{slug}.com/api/v2/status.json   (Atlassian Statuspage)
status.{slug}.com/summary.json         (Instatus)
status.{slug}.io/api/v2/status.json
{slug}.statuspage.io/api/v2/status.json
...
```

All probes use `AbortSignal.timeout(2000)` to fail fast. `Promise.any()` returns the first successful hit. This runs during Marketplace search (capped at 12 unique vendors per query to bound latency to ~2 s).

### Vendor Name Normalisation

Raw Marketplace vendor names go through `normalizeVendorName()` before any lookup. This collapses M&A histories:

| Raw name | Normalised to |
|---|---|
| SoftwarePlant | appfire |
| ALM Works | tempo software |
| OnResolve | adaptavist |
| iDalko / iGo Software | exalate |
| Axosoft | gitkraken |

---

## Health Check Engine

`POST /api/status` accepts an array of `RegisteredApp` objects and returns health results for each. It auto-detects the response format:

### Supported formats

| Format | Detection | Example vendors |
|---|---|---|
| **Atlassian Statuspage** `summary.json` | `payload.status.indicator` field present | SmartBear, Adaptavist, Tempo, Gliffy |
| **Instatus** `summary.json` | `payload.page.status` field present | OBoard, Exalate |
| **Hund.io / JSON:API** `index.json` | `payload.data` + `payload.included` present | draw.io |
| **HTTP ping** | `checkType === "http_ping"` | Any URL |

### Status mapping

| Raw status | Our status |
|---|---|
| `operational`, `none` indicator, `UP` | ✅ Operational |
| `degraded_performance`, `minor` indicator, `UNDERMAINTENANCE` | ⚠️ Degraded |
| `partial_outage`, `major_outage`, `critical`, `PARTIALOUTAGE`, `MAJOROUTAGE` | 🔴 Outage |

### Per-app component matching on unified pages

Many vendors host all their products on one status page (e.g. Adaptavist hosts ScriptRunner, Bitbucket Connector, ScriptRunner for Confluence, etc. all under `status.connect.adaptavist.com`). A global `"partial outage"` on that page could mean any one of dozens of components is down — not necessarily the app you care about.

The health check engine runs a two-pass match against the component list:

1. **Fuzzy name match** — strips "for Jira/Confluence" suffixes and normalises punctuation, then checks for substring inclusion both ways
2. **Token score match** — tokenises the app name (excluding stop words and platform words like "jira"), scores each component by keyword and platform overlap

Only a non-zero score component is selected. If no component matches, the global page status is used.

---

## Data Model

All state lives in `localStorage` — no database or authentication required.

```ts
// localStorage key: "jira-marketplace-apps"
RegisteredApp {
  id: string           // Marketplace addon key (e.g. "com.mxgraph.jira.drawio")
  appName: string
  vendorName: string
  checkType: CheckType // "statuspage_api" | "http_ping" | "custom"
  statusUrl: string    // Resolved API endpoint
  logoUrl?: string     // CDN URL from Marketplace
}

// localStorage key: "jira-marketplace-history"
Record<appId, PingRecord[]>  // Up to last 30 pings per app

PingRecord {
  status: "operational" | "degraded" | "outage"
  timestamp: string     // ISO 8601
  responseTimeMs: number | null
  message?: string
}
```

On every mount, stored apps are migrated against the latest `PRODUCT_RULES` and `VENDOR_STATUS_MAP`. This silently fixes stale status URLs from old versions without requiring a manual reset.

---

## API Routes

### `POST /api/status`

Run health checks for a batch of apps.

**Request:**
```json
{
  "apps": [
    {
      "id": "com.onresolve.jira.groovy.groovyrunner",
      "appName": "ScriptRunner for Jira",
      "vendorName": "Adaptavist",
      "checkType": "statuspage_api",
      "statusUrl": "https://status.connect.adaptavist.com/api/v2/summary.json"
    }
  ]
}
```

**Response:**
```json
{
  "results": [
    {
      "appId": "com.onresolve.jira.groovy.groovyrunner",
      "status": "operational",
      "checkedAt": "2026-05-02T09:00:00.000Z",
      "responseTimeMs": 312,
      "message": "ScriptRunner for Jira: operational"
    }
  ]
}
```

### `GET /api/marketplace/search?query={text}&limit={n}`

Proxy to the Atlassian Marketplace REST API v2. Returns apps enriched with resolved status URLs. Runs auto-discovery for vendors not in the static map.

> The Marketplace API uses `text=` (not `q=`) for full-text search. This proxy handles the parameter correctly and re-ranks results by text similarity before returning.

### `GET /api/marketplace/popular`

Returns a curated list of 21 popular Jira apps grouped by category, with logos and status URLs resolved. Results are cached in-memory for 1 hour to avoid hammering the Marketplace API.

**Categories:** Automation · Time Tracking · Testing & QA · Diagrams · Reporting · Planning · Dev Tools · Integrations · Utilities

---

## Getting Started

### Prerequisites

- Node.js 18+
- npm 9+

### Installation

```bash
git clone https://github.com/happy-yeachan/SaaS-Jira-Apps-Status.git
cd SaaS-Jira-Apps-Status
npm install
```

### Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Production Build

```bash
npm run build
npm start
```

No environment variables required. The app uses only public APIs (Atlassian Marketplace REST API v2 and vendor status pages).

---

## Extending the App

### Adding a new vendor to the static map

Edit `VENDOR_STATUS_MAP` in `src/types/index.ts`:

```ts
"yourvendor": "https://status.yourvendor.com/api/v2/summary.json",
```

Keys are lowercase. Use `summary.json` over `status.json` — the health check engine needs component-level data for per-app matching on unified vendor pages.

If the vendor name in the Marketplace differs from your map key (e.g. due to acquisitions), add a normalisation rule to `normalizeVendorName()` in `src/lib/status-discovery.ts`:

```ts
if (l.includes("acquiredname")) return "yourvendor";
```

### Adding a product-specific rule

Use this when a product has its own dedicated status page separate from the parent vendor. Add to `PRODUCT_RULES` in `src/types/index.ts` **before** any generic vendor entry for the same vendor:

```ts
{ keywords: ["your product name"], url: "https://status.yourproduct.com/api/v2/summary.json" },
```

Rules are matched by substring against the app name (case-insensitive). More specific rules must appear before broader ones.

### Marking a vendor as having no status page

Add to `VENDOR_BLACKLIST` in `src/types/index.ts` to suppress auto-discovery and skip status checks for that vendor's apps:

```ts
export const VENDOR_BLACKLIST = new Set([
  "yourvendor",
]);
```

### Adding to the Quick Setup list

Edit the `CURATED` array in `src/app/api/marketplace/popular/route.ts`:

```ts
{ query: "Your App Name for Jira", vendorHint: "vendorname", category: "Utilities" },
```

- `query` — passed as-is to the Marketplace search API
- `vendorHint` — substring matched against the vendor name to pick the correct result when multiple apps share similar names
- `category` — must be one of: `Automation` · `Time Tracking` · `Testing & QA` · `Diagrams` · `Reporting` · `Planning` · `Dev Tools` · `Integrations` · `Utilities`

---

## Architecture Decisions

**Why no database?** The target user is a single Jira administrator or developer who wants a personal dashboard. `localStorage` is simpler, faster, and requires zero infrastructure. The app works offline after first load.

**Why a Next.js server proxy for status checks?** Vendor status pages block direct browser requests via CORS. Running the fetch from the Next.js server avoids this entirely. The proxy also normalises response formats so the client never has to handle Statuspage vs. Instatus differences.

**Why a static vendor map instead of scraping?** Status page URLs rarely change. A curated map gives deterministic, tested results. Auto-discovery fills the gap for the long tail of vendors not yet in the map.

**Why `summary.json` over `status.json`?** The Atlassian Statuspage `summary.json` endpoint includes the full component list, which is required for per-app component matching on unified vendor pages. `status.json` only returns the global indicator. The health check route upgrades any legacy `status.json` URLs transparently.

**Why not import from Jira directly?** Jira's UPM REST API only returns apps installed via the traditional P2 (server/DC) plugin system. Forge apps (the modern cloud platform) — which includes ScriptRunner Cloud and many newer apps — are invisible to UPM. Since this would silently miss a large fraction of cloud-hosted apps, the import flow was replaced with the Quick Setup curated list and Marketplace search, both of which use the public Marketplace API.

---

## License

MIT
