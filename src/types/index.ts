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
  { keywords: ["custom charts"],                     url: "https://status.customcharts.tempo.io/api/v2/status.json" },
  { keywords: ["custom jira charts"],                url: "https://status.customcharts.tempo.io/api/v2/status.json" },
  { keywords: ["structure"],                         url: "https://status.tempo.io/api/v2/status.json" },
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
 * Maps vendor name → Statuspage API URL (fallback when no product rule matches).
 * All entries are Atlassian Statuspage instances so checkType is always
 * "statuspage_api". The public status page URL is derived by stripping
 * "/api/v2/status.json" from the end of each URL.
 */
export const VENDOR_STATUS_MAP: Record<string, string> = {
  // ── Top-tier vendors ─────────────────────────────────────────────────────
  "Appfire":            "https://appfire-apps.statuspage.io/api/v2/summary.json",
  "Tempo Software":     "https://status.tempo.io/api/v2/summary.json",
  "Adaptavist":         "https://status.connect.adaptavist.com/api/v2/summary.json",
  "SmartBear":          "https://zephyr.status.smartbear.com/api/v2/summary.json",

  // ── Diagramming & whiteboarding ──────────────────────────────────────────
  "Seibert Media":      "https://status.draw.io/index.json",
  "JGraph":             "https://status.draw.io/index.json",
  "Gliffy":             "https://status.gliffy.com/api/v2/status.json",
  "Balsamiq":           "https://status.balsamiq.com/api/v2/status.json",
  "Lucid":              "https://status.lucid.co/api/v2/status.json",
  "Miro":               "https://status.miro.com/api/v2/status.json",

  // ── Reporting, BI & data ─────────────────────────────────────────────────
  "eazyBI":             "https://status.eazybi.com/api/v2/status.json",
  "K15t":               "https://status.k15t.com/api/v2/status.json",
  "Midori":             "https://status.midori-global.com/api/v2/status.json",
  "Oboard":             "https://status.oboard.io/api/v2/status.json",

  // ── QA, testing & security ───────────────────────────────────────────────
  "Xblend":             "https://xray.statuspage.io/api/v2/summary.json",
  "QMetry":             "https://status.qmetry.com/api/v2/status.json",
  "Tricentis":          "https://status.tricentis.com/api/v2/status.json",
  "Resolution":         "https://status.resolution.de/api/v2/status.json",

  // ── Dev tools & integrations ─────────────────────────────────────────────
  "GitKraken":          "https://status.gitkraken.com/api/v2/status.json",
  "Exalate":            "https://status.exalate.com/api/v2/status.json",
  "Move Work Forward":  "https://status.moveworkforward.com/api/v2/status.json",

  // ── Utilities & agile management ─────────────────────────────────────────
  "Deviniti":           "https://status.deviniti.com/api/v2/status.json",
  "Refined":            "https://status.refined.com/api/v2/status.json",
  "Elements":           "https://status.elements-apps.com/api/v2/status.json",
  "Deiser":             "https://status.deiser.com/api/v2/status.json",
  "Easy Agile":         "https://status.easyagile.com/api/v2/status.json",
  "Aha!":               "https://status.aha.io/api/v2/status.json",
  "ProjectBalm":        "https://status.projectbalm.com/api/v2/status.json",
};

export function lookupVendorStatus(vendorName: string): VendorStatusConfig | null {
  const normalized = vendorName.toLowerCase().trim();
  for (const [key, url] of Object.entries(VENDOR_STATUS_MAP)) {
    const keyNorm = key.toLowerCase();
    // Never use keyNorm.includes(normalized) : short substrings like "software" would
    // incorrectly match "Tempo Software" and other long keys.
    if (
      keyNorm === normalized ||
      normalized.includes(keyNorm)
    ) {
      return { statusUrl: url, checkType: "statuspage_api" };
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
