export type CheckType = "statuspage_api" | "http_ping" | "custom";

export type AppHealthStatus = "operational" | "degraded" | "outage";

export interface PingRecord {
  status: AppHealthStatus;
  timestamp: string;
  responseTimeMs: number | null;
  message?: string;
}

export interface RegisteredApp {
  id: string;
  appName: string;
  vendorName: string;
  checkType: CheckType;
  statusUrl: string;
  logoUrl?: string;
}

export interface VendorStatusConfig {
  statusUrl: string;
  checkType: CheckType;
}

/**
 * Product-specific keyword rules — evaluated BEFORE the vendor map.
 * Rules are checked in order; the first rule whose every keyword appears in
 * the app name (case-insensitive) wins.
 *
 * Use this when a product ships under a different status subdomain from its
 * parent vendor (e.g. Zephyr Enterprise has its own page, not SmartBear's).
 */
export const PRODUCT_RULES: Array<{ keywords: string[]; url: string }> = [
  // ── SmartBear — Zephyr family (most-specific first) ─────────────────────
  { keywords: ["zephyr essential"],                  url: "https://zephyr-essential.status.smartbear.com/api/v2/status.json" },
  { keywords: ["zephyr squad"],                      url: "https://zephyr-essential.status.smartbear.com/api/v2/status.json" },
  { keywords: ["zephyr enterprise"],                 url: "https://zephyr-enterprise.status.smartbear.com/api/v2/status.json" },
  { keywords: ["zephyr"],                            url: "https://zephyr.status.smartbear.com/api/v2/status.json" },
  { keywords: ["swagger"],                           url: "https://status.swagger.io/api/v2/status.json" },
  { keywords: ["bitbar"],                            url: "https://status.bitbar.com/api/v2/status.json" },

  // ── Tempo Software — acquired products & specific apps ───────────────────
  // "custom charts" and "structure" are generic words; require "jira" co-occurrence
  // so unrelated apps ("Custom Chart Library", "Org Structure Manager") are not matched.
  { keywords: ["custom charts", "jira"],             url: "https://status.customcharts.tempo.io/api/v2/status.json" },
  { keywords: ["custom jira charts"],                url: "https://status.customcharts.tempo.io/api/v2/status.json" },
  { keywords: ["structure", "jira"],                 url: "https://status.tempo.io/api/v2/status.json" },
  { keywords: ["alm works"],                         url: "https://status.tempo.io/api/v2/status.json" },
  { keywords: ["timesheets", "tempo"],               url: "https://status.tempo.io/api/v2/status.json" },
  { keywords: ["planner", "tempo"],                  url: "https://status.tempo.io/api/v2/status.json" },

  // ── draw.io (Seibert Media / JGraph) ────────────────────────────────────
  { keywords: ["draw.io"],                           url: "https://status.draw.io/index.json" },
  { keywords: ["drawio"],                            url: "https://status.draw.io/index.json" },

  // ── Appfire — acquired products (unified page on appfire-apps.statuspage.io) ─
  { keywords: ["bigpicture"],        url: "https://appfire-apps.statuspage.io/api/v2/summary.json" },
  { keywords: ["advanced tables"],   url: "https://appfire-apps.statuspage.io/api/v2/summary.json" },
  { keywords: ["bob swift"],         url: "https://appfire-apps.statuspage.io/api/v2/summary.json" },

  // ── Adaptavist ───────────────────────────────────────────────────────────
  { keywords: ["scriptrunner"],                      url: "https://status.connect.adaptavist.com/api/v2/summary.json" },
];

/**
 * Resolve the Statuspage API URL for an app using a two-step lookup:
 *   1. PRODUCT_RULES  — app-name keyword match (highest priority)
 *   2. VENDOR_STATUS_MAP — vendor-name fuzzy match (fallback)
 *
 * Returns null when neither map has an entry for the given app/vendor.
 */
export function resolveStatusUrl(
  appName: string,
  vendorName: string,
): VendorStatusConfig | null {
  const nameLower = appName.toLowerCase();

  for (const { keywords, url } of PRODUCT_RULES) {
    if (keywords.every((kw) => nameLower.includes(kw.toLowerCase()))) {
      return { statusUrl: url, checkType: "statuspage_api" };
    }
  }

  return lookupVendorStatus(vendorName);
}

/**
 * Single source of truth for vendor → status-page URL.
 *
 * Keys are lowercase so lookups work with both raw Marketplace names and
 * the normalized keys produced by `normalizeVendorName()` in status-discovery.ts.
 * All URLs are Atlassian Statuspage summary endpoints (summary.json includes
 * component-level status; the status route upgrades status.json → summary.json
 * transparently for any stale localStorage entries).
 *
 * Vendors confirmed to have no public status page live in VENDOR_BLACKLIST below.
 */
export const VENDOR_STATUS_MAP: Record<string, string> = {
  // ── M&A giants ────────────────────────────────────────────────────────────
  "appfire":            "https://appfire-apps.statuspage.io/api/v2/summary.json",
  "tempo software":     "https://status.tempo.io/api/v2/summary.json",
  "adaptavist":         "https://status.connect.adaptavist.com/api/v2/summary.json",
  "smartbear":          "https://zephyr.status.smartbear.com/api/v2/summary.json",

  // ── Diagramming & whiteboarding ───────────────────────────────────────────
  "seibert media":      "https://status.draw.io/index.json",
  "jgraph":             "https://status.draw.io/index.json",
  "gliffy":             "https://status.gliffy.com/api/v2/summary.json",
  "balsamiq":           "https://status.balsamiq.com/api/v2/summary.json",
  "lucid":              "https://status.lucid.co/api/v2/summary.json",
  "miro":               "https://status.miro.com/api/v2/summary.json",

  // ── Reporting, BI & data ──────────────────────────────────────────────────
  "eazybi":             "https://status.eazybi.com/api/v2/summary.json",
  "oboard":             "https://oboard.instatus.com/summary.json",

  // ── QA, testing & security ────────────────────────────────────────────────
  "xblend":             "https://xray.statuspage.io/api/v2/summary.json",
  "qmetry":             "https://status.qmetry.com/api/v2/summary.json",
  "tricentis":          "https://status.tricentis.com/api/v2/summary.json",
  "resolution":         "https://status.resolution.de/api/v2/summary.json",

  // ── Dev tools & integrations ──────────────────────────────────────────────
  "gitkraken":          "https://gij.gitkrakenstatus.com/api/v2/summary.json",
  "herocoders":         "https://status.herocoders.com/api/v2/summary.json",
  "exalate":            "https://status.exalate.com/api/v2/summary.json",
  "move work forward":  "https://status.moveworkforward.com/api/v2/summary.json",
  "valiantys":          "https://status.elements-apps.com/api/v2/summary.json",

  // ── Utilities & agile management ──────────────────────────────────────────
  "deviniti":           "https://status.deviniti.com/api/v2/summary.json",
  "refined":            "https://status.refined.com/api/v2/summary.json",
  // "elements" removed — duplicate of "valiantys" above, and the short key
  // "elements" is a substring of many unrelated vendor names ("Data Elements Inc" etc.).
  "deiser":             "https://status.deiser.com/api/v2/summary.json",
  "easy agile":         "https://status.easyagile.com/api/v2/summary.json",
  "aha!":               "https://status.aha.io/api/v2/summary.json",
  "projectbalm":        "https://status.projectbalm.com/api/v2/summary.json",
  "decadis":            "https://status.decadis.com/api/v2/summary.json",
};

/**
 * Vendors confirmed to have no public status page.
 * Auto-discovery is skipped for these in the import pipeline.
 * Keys match the lowercase output of `normalizeVendorName()`.
 */
export const VENDOR_BLACKLIST = new Set([
  "k15t",
  "midori",
  "reliex",
  "ease solutions",
  "open source consulting",
]);

export function lookupVendorStatus(vendorName: string): VendorStatusConfig | null {
  const normalized = vendorName.toLowerCase().trim();
  for (const [key, url] of Object.entries(VENDOR_STATUS_MAP)) {
    // Exact match — always correct.
    if (key === normalized) return { statusUrl: url, checkType: "statuspage_api" };

    // Prefix match: the normalized vendor name STARTS WITH the key.
    // Examples that correctly resolve:
    //   normalized="tempo software ltd"  key="tempo software" → startsWith ✓
    //   normalized="lucid software inc"  key="lucid"          → startsWith ✓
    //   normalized="appfire partner"     key="appfire"        → startsWith ✓
    //
    // This is safer than normalized.includes(key), which would match the key
    // anywhere inside the vendor name — e.g. "Advanced Elements Studio"
    // would match key "elements", which is wrong.
    //
    // A word-boundary check is added so "refined" doesn't accidentally match
    // "refinedx" (a concatenation without a space after the key).
    if (normalized.startsWith(key)) {
      const charAfter = normalized[key.length];
      if (charAfter === undefined || charAfter === " ") {
        return { statusUrl: url, checkType: "statuspage_api" };
      }
    }
  }
  return null;
}

export interface MarketplaceSearchItem {
  id: string;
  appName: string;
  vendorName: string;
  logoUrl?: string;
  /** Resolved server-side via VENDOR_STATUS_MAP. Empty string if vendor is unknown. */
  statusUrl: string;
  /** Resolved server-side. "custom" when statusUrl is empty. */
  checkType: CheckType;
}

export interface HealthCheckResult {
  appId: string;
  status: AppHealthStatus;
  checkedAt: string;
  responseTimeMs: number | null;
  message?: string;
}

export interface HealthCheckResponse {
  results: HealthCheckResult[];
}
