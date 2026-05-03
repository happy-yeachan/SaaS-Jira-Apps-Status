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
| **Auto-discovery** | For vendors not in the static map, probes common patterns (`status.vendor.com`, `vendor.statuspage.io`, etc.) in parallel with page-name validation to prevent false positives. |
| **Self-healing URLs** | When a vendor moves their status page, the dashboard detects DNS failure, auto-discovers the new URL, retries the check, and silently persists the replacement — no manual fix needed. |
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
│       │   └── route.ts            # POST — health check engine (Statuspage, Instatus, Hund parsers, self-healing)
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

Status URL resolution is a four-step pipeline, evaluated in priority order:

### Step 1 — PRODUCT_RULES (highest priority)

`src/types/index.ts` contains keyword rules for products that have their own status page distinct from their parent vendor. Rules are matched against the app name (case-insensitive substring match).

```ts
{ keywords: ["zephyr enterprise"],  url: "https://zephyr-enterprise.status.smartbear.com/api/v2/status.json" },
{ keywords: ["scriptrunner"],       url: "https://status.connect.adaptavist.com/api/v2/summary.json" },
{ keywords: ["draw.io"],            url: "https://status.draw.io/index.json" },
```

Rules are evaluated in order — more specific entries must appear before broader ones. Rules also support an optional `vendor` guard field: when present, the normalised vendor name must also contain the guard string. This prevents generic keywords like `"structure"` or `"custom charts"` from matching apps by unrelated vendors.

```ts
// Only routes to Tempo if the vendor name also contains "tempo"
{ keywords: ["structure", "jira"], vendor: "tempo", url: "https://status.tempo.io/api/v2/status.json" },
```

### Step 2 — VENDOR_STATUS_MAP (fallback)

If no product rule matches, the vendor name is looked up in the static map. The lookup uses a `startsWith` + word-boundary check (not `includes`) to prevent partial-name collisions — e.g. `"refined"` must not match `"refinedx"`.

```ts
"tempo software":  "https://status.tempo.io/api/v2/summary.json",
"gitkraken":       "https://gij.gitkrakenstatus.com/api/v2/summary.json",
"lucid":           "https://status.lucid.co/api/v2/summary.json",
```

Raw Marketplace vendor names go through `normalizeVendorName()` before any lookup, collapsing M&A histories:

| Raw name | Normalised to |
|---|---|
| SoftwarePlant | appfire |
| Bob Swift | appfire |
| ALM Works | tempo software |
| Old Street Solutions | tempo software |
| OnResolve | adaptavist |
| iDalko / iGo Software | exalate |
| Axosoft | gitkraken |
| Xpand IT | xblend |

### Step 3 — Auto-discovery (for unknown vendors)

When neither map has an entry, `discoverStatusUrl()` in `src/lib/status-discovery.ts` probes common URL patterns in parallel:

```
status.{slug}.com/api/v2/status.json   (Atlassian Statuspage)
status.{slug}.com/summary.json         (Instatus)
status.{slug}.io/api/v2/status.json
{slug}.statuspage.io/api/v2/status.json
...
```

Each probe goes through two validation layers before being accepted:

1. **Shape validation** (`isStatuspageLike`) — the JSON must have `status.indicator` (Statuspage), `page.status` (Instatus), or `data` + `included` (Hund.io). Arbitrary JSON endpoints that happen to respond with 200 are rejected.
2. **Page-name validation** (`vendorPageNameMatch`) — the status page's own `page.name` must share the majority of meaningful tokens with the vendor name. Prevents `"Catapult Labs"` from matching a different company called "Catapult" that happens to own `status.catapult.com`.

Slugs that are too short (< 5 chars) or match a 50+ word blocklist of common English words (`open`, `smart`, `flow`, `work`, `release`, etc.) are skipped entirely.

All probes use `AbortSignal.timeout(2000)` to fail fast. `Promise.any()` returns the first successful hit. Runs during Marketplace search (capped at 12 unique vendors per query, bounding added latency to ~2 s).

### Step 4 — Self-healing (runtime URL recovery)

When a health check throws a DNS/connection error (`ENOTFOUND`, `ECONNREFUSED`, `getaddrinfo`, etc.) the stored URL is stale — the vendor moved their status page. The catch block:

1. Calls `discoverStatusUrl()` to find the new URL (same 2 s probe budget).
2. Retries the health check against the new URL so the current request still returns a real result.
3. Returns `updatedStatusUrl` in the response.

The dashboard's `applyResults()` detects the field and calls `setApps()` to overwrite the stored URL in localStorage. All future checks automatically use the correct address — no user action required.

Self-healing only activates for `checkType === "statuspage_api"` apps. `http_ping` apps monitor URLs explicitly chosen by the user; silently replacing them would be wrong.

---

## False Positive Prevention

The pipeline uses multiple independent layers to ensure status data is always meaningful:

| Layer | Where | What it prevents |
|---|---|---|
| `isStatuspageLike()` | `status-discovery.ts` | Arbitrary JSON endpoints accepted as status pages |
| `vendorPageNameMatch()` | `status-discovery.ts` | Discovery binding to the wrong company's status page |
| `SLUG_BLOCKLIST` (50+ words) | `status-discovery.ts` | Generic English words probed as subdomains (`status.open.com`, `status.work.io`, …) |
| `startsWith` + word boundary | `types/index.ts` | Partial vendor name collisions in VENDOR_STATUS_MAP lookup |
| `vendor?` guard on PRODUCT_RULES | `types/index.ts` | Generic keyword rules matching apps from unrelated vendors |
| `VENDOR_BLACKLIST` | `types/index.ts` | Vendors without public status pages picked up by auto-discovery |
| Blacklist check in `enrichWithDiscovery` | `marketplace/search/route.ts` | Blacklisted vendors re-entering discovery via the empty-statusUrl filter |

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

1. **Fuzzy name match** — strips "for Jira/Confluence" suffixes and normalises punctuation, then checks for substring inclusion both ways.
2. **Token score match** — tokenises the app name (excluding stop words and platform words like "jira"), scores each component by keyword and platform overlap.

Platform words (`jira`, `confluence`) are excluded from the main token set and scored separately. A component that only shares a platform word with the app name scores 0 — this prevents every `"* for Jira"` entry on a unified page from being treated as a match.

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
      "checkedAt": "2026-05-03T09:00:00.000Z",
      "responseTimeMs": 312,
      "message": "ScriptRunner for Jira: operational"
    }
  ]
}
```

When a vendor's status page URL has changed and self-healing kicks in, the result also includes:

```json
{
  "appId": "...",
  "status": "operational",
  "updatedStatusUrl": "https://new.vendor-status.com/api/v2/summary.json",
  "updatedCheckType": "statuspage_api"
}
```

The client persists the new URL to localStorage automatically.

### `GET /api/marketplace/search?query={text}&limit={n}`

Proxy to the Atlassian Marketplace REST API v2. Returns apps enriched with resolved status URLs. Runs auto-discovery for vendors not in the static map (capped at 12 unique vendors per query). Blacklisted vendors are excluded from discovery.

> The Marketplace API uses `text=` (not `q=`) for full-text search. This proxy handles the parameter correctly and re-ranks results by text similarity before returning.

### `GET /api/marketplace/popular`

Returns a curated list of popular Jira apps grouped by category, with logos and status URLs resolved. Results are cached in-memory for 1 hour to avoid hammering the Marketplace API.

**Categories:** Automation · Time Tracking · Testing & QA · Diagrams · Reporting · Planning · Dev Tools · Integrations · Utilities

---

## Supported Vendors

The following vendors are covered by the static map (`VENDOR_STATUS_MAP`) and will always resolve without auto-discovery:

| Vendor | Status Page |
|---|---|
| Atlassian | status.atlassian.com |
| Appfire (+ SoftwarePlant, Bob Swift, Comalatech, …) | appfire-apps.statuspage.io |
| Tempo Software (+ ALM Works, Old Street, Roadmunk, …) | status.tempo.io |
| Adaptavist (+ OnResolve, Brikit, Meetical) | status.connect.adaptavist.com |
| SmartBear (+ Zephyr family, BitBar, Cucumber) | zephyr.status.smartbear.com |
| GitKraken (+ Axosoft) | gij.gitkrakenstatus.com |
| Exalate (+ iDalko, iGo Software) | status.exalate.com |
| JGraph (draw.io) | status.draw.io |
| Gliffy | status.gliffy.com |
| Balsamiq | status.balsamiq.com |
| Lucid | status.lucid.co |
| Miro | status.miro.com |
| EazyBI | status.eazybi.com |
| OBoard | oboard.instatus.com |
| Xblend / Xpand IT (Xray) | xray.statuspage.io |
| Tricentis | status.tricentis.com |
| Resolution | status.resolution.de |
| HeroCoders | status.herocoders.com |
| Move Work Forward | status.moveworkforward.com |
| Valiantys (Elements) | status.elements-apps.com |
| Deviniti | deviniti.statuspage.io |
| Refined | status.refined.com |
| Deiser | status.deiser.com |
| Easy Agile | status.easyagile.com |
| Aha! | status.aha.io |
| ProjectBalm | projectbalm.statuspage.io |
| DevSamurai | status.devsamurai.com |
| Twinit | twinit.statuspage.io |
| SolDevelo | soldevelo.statuspage.io |
| Bloompeak | bloompeak.statuspage.io |

Product-specific rules in `PRODUCT_RULES` also cover individual products within these vendors that operate separate status pages (e.g. Zephyr Essential, Zephyr Enterprise, Zephyr Squad each have their own SmartBear subdomains).

Vendors confirmed to have no public status page (`VENDOR_BLACKLIST`): `k15t`, `midori`, `reliex`, `ease solutions`, `open source consulting`, `decadis`.

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

If the product name keywords are generic English words that could appear in unrelated app names, add a `vendor` guard:

```ts
{ keywords: ["your product", "jira"], vendor: "yourvendor", url: "https://..." },
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

**Why self-healing instead of just reporting a URL error?** Reliability is the core promise of this dashboard. If the stored URL is stale (DNS failure) and the app simply reports "outage", that's a false alarm — worse than useless during an actual incident. Self-healing distinguishes network-level failures (stale URL) from HTTP-level failures (real outage) and recovers automatically, so the health signal stays trustworthy.

---

## License

MIT
