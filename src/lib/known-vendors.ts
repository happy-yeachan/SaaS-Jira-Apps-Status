/**
 * Hand-verified vendor → status-page URL map for the Jira import pipeline.
 *
 * Keys are **lowercase** canonical names from `normalizeVendorName` so lookups
 * are stable and match `KNOWN_VENDOR_MAP[normalizedKey]` without case drift.
 *
 * Values: a working status-page API URL, or `null` to blacklist (skip discovery).
 *
 * Priority in the import flow:
 *   1. KNOWN_VENDOR_MAP   ← this file
 *   2. resolveStatusUrl   (PRODUCT_RULES then VENDOR_STATUS_MAP in types/index.ts)
 *   3. discoverStatusUrl  (last resort)
 */

/** Sentinel: vendor has no public status page — skip auto-discovery. */
export const NO_STATUS_PAGE = null;

export const KNOWN_VENDOR_MAP: Record<string, string | null> = {
  // ── M&A giants ────────────────────────────────────────────────────────────
  // NOT status.appfire.com — use Statuspage-hosted summary (components[]).
  "appfire":        "https://appfire-apps.statuspage.io/api/v2/summary.json",

  "tempo software": "https://status.tempo.io/api/v2/summary.json",

  // OnResolve/ScriptRunner share this page — must be status.*connect*.adaptavist.com
  "adaptavist":     "https://status.connect.adaptavist.com/api/v2/summary.json",

  "smartbear":      "https://zephyr.status.smartbear.com/api/v2/summary.json",

  // ── Diagramming & whiteboarding ───────────────────────────────────────────
  "seibert media":  "https://status.draw.io/index.json",
  "jgraph":         "https://status.draw.io/index.json",

  "gliffy":         "https://status.gliffy.com/api/v2/summary.json",
  "balsamiq":       "https://status.balsamiq.com/api/v2/summary.json",
  "lucid":          "https://status.lucid.co/api/v2/summary.json",

  // ── QA & testing ──────────────────────────────────────────────────────────
  "xblend":         "https://xray.statuspage.io/api/v2/summary.json",
  "qmetry":         "https://status.qmetry.com/api/v2/summary.json",

  // ── Reporting & BI ────────────────────────────────────────────────────────
  "eazybi":         "https://status.eazybi.com/api/v2/summary.json",

  // Decadis (e.g. Sumup for Jira)
  "decadis":        "https://status.decadis.com/api/v2/summary.json",

  // ── Dev tools & integrations ──────────────────────────────────────────────
  "gitkraken":      "https://status.gitkraken.com/api/v2/summary.json",
  "herocoders":     "https://status.herocoders.com/api/v2/summary.json",
  "exalate":        "https://status.exalate.com/api/v2/summary.json",

  // ── Agile & project management ────────────────────────────────────────────
  "easy agile":     "https://status.easyagile.com/api/v2/summary.json",
  "elements":       "https://status.elements-apps.com/api/v2/summary.json",
  "refined":        "https://status.refined.com/api/v2/summary.json",
  "deiser":         "https://status.deiser.com/api/v2/summary.json",
  "aha!":           "https://status.aha.io/api/v2/summary.json",

  // ── Blacklist — no public status page; null skips auto-discovery ──────────
  "k15t":           NO_STATUS_PAGE,
  "deviniti":       NO_STATUS_PAGE,
  "midori":         NO_STATUS_PAGE,
  "reliex":         NO_STATUS_PAGE,
  "ease solutions": NO_STATUS_PAGE,
  "open source consulting": NO_STATUS_PAGE,
};
