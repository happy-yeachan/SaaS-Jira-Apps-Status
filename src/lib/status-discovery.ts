/**
 * Status-page auto-discovery.
 *
 * When a vendor is NOT in our hand-maintained VENDOR_STATUS_MAP we attempt to
 * guess common status-page URL patterns and probe them in parallel.  The first
 * URL that responds with HTTP 200 + an application/json body is returned.
 *
 * All probes use a 2-second AbortSignal timeout so a dead host never blocks
 * the import flow.
 */

import type { CheckType } from "@/types";

export interface DiscoveredStatus {
  statusUrl: string;
  checkType: CheckType;
}

/**
 * Returns true only if the parsed JSON looks like a known status-page format.
 *
 * Prevents false positives where an arbitrary JSON endpoint (error pages,
 * API responses, health checks that happen to return JSON) gets accepted.
 *
 * Recognised shapes:
 *   Atlassian Statuspage — { status: { indicator: string } }
 *   Instatus             — { page: { status: string } }
 *   Hund.io / JSON:API   — { data: ..., included: [...] }
 */
function isStatuspageLike(json: unknown): boolean {
  if (!json || typeof json !== "object") return false;
  const j = json as Record<string, unknown>;
  const status = j.status as Record<string, unknown> | undefined;
  const page = j.page as Record<string, unknown> | undefined;
  return (
    typeof status?.indicator === "string" ||
    typeof page?.status === "string" ||
    (j.data !== undefined && Array.isArray(j.included))
  );
}

/** Probe one URL — returns the URL only if it serves a recognisable status-page JSON. */
async function probeUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
      headers: {
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (compatible; StatusDiscovery/1.0)",
      },
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) return null;
    // Validate the payload is actually a status-page response, not an arbitrary
    // JSON endpoint (error pages, generic APIs) that happens to be reachable.
    const json = await res.json();
    if (!isStatuspageLike(json)) return null;
    return url;
  } catch {
    return null;
  }
}

// ── Vendor normalisation ─────────────────────────────────────────────────────
// Jira's UPM often returns legacy or acquired company names instead of the
// current parent-brand name.  Normalising before any map lookup means
// "SoftwarePlant" (BigPicture), "Bob Swift", "ALM Works", etc. all resolve to
// the correct status page entry without requiring separate map keys.

/**
 * Map a raw UPM vendor name to a canonical **lowercase** key shared with
 * `KNOWN_VENDOR_MAP` and `lookupVendorStatus` (which matches case-insensitively).
 */
export function normalizeVendorName(rawVendor: string): string {
  if (!rawVendor) return "unknown";
  if (rawVendor === "Unknown") return "unknown";
  const l = rawVendor.toLowerCase();
  const words = l.split(/[^a-z0-9]+/).filter((w) => w.length > 0);

  // ── Appfire empire ──────────────────────────────────────────────────────
  if (
    l.includes("appfire") ||
    l.includes("bob swift") ||
    l.includes("softwareplant") ||
    l.includes("comalatech") ||
    l.includes("innovalog") ||
    l.includes("botron") ||
    l.includes("witified") ||
    l.includes("canned responses")
  ) return "appfire";

  // Open Source Consulting (OSCI) — single map key; run before Tempo
  if (
    l.includes("open source consulting") ||
    l.includes("osci") ||
    words.includes("osci")
  ) {
    return "open source consulting";
  }

  // Decadis (e.g. Sumup for Jira) — before Tempo; "decadis" never contains "tempo"
  if (l.includes("decadis")) {
    return "decadis";
  }

  // ── Tempo empire ────────────────────────────────────────────────────────
  // Do NOT use l.includes("tempo") — that matches the letters inside "Contemporary".
  // Require "tempo" as a token or known acquisition names.
  const hasTempoToken = words.includes("tempo");
  const isTempoEmpire =
    l === "tempo" ||
    l === "tempo software" ||
    l.includes("alm works") ||
    l.includes("old street") ||
    l.includes("roadmunk") ||
    l.includes("liquidmath") ||
    hasTempoToken;
  if (isTempoEmpire) {
    return "tempo software";
  }

  // ── SmartBear empire ────────────────────────────────────────────────────
  if (
    l.includes("smartbear") ||
    l.includes("zephyr") ||
    l.includes("cucumber") ||
    l.includes("bitbar")
  ) return "smartbear";

  // ── Adaptavist empire (incl. OnResolve = ScriptRunner vendor) ───────────
  if (
    l.includes("adaptavist") ||
    l.includes("onresolve") ||
    l.includes("brikit") ||
    l.includes("meetical")
  ) {
    return "adaptavist";
  }

  // ── GitKraken empire ────────────────────────────────────────────────────
  if (l.includes("gitkraken") || l.includes("axosoft")) return "gitkraken";

  // ── Exalate (formerly iDalko, rebranded to iGo Software) ────────────────
  if (l.includes("idalko") || l.includes("igo software") || l === "exalate") return "exalate";

  // ── draw.io (Seibert Media / JGraph) ────────────────────────────────────
  if (l.includes("seibert") || l.includes("jgraph")) return "seibert media";

  // ── Xblend / Xpand IT (Xray) ────────────────────────────────────────────
  if (l.includes("xblend") || l.includes("xpand it")) return "xblend";

  // Strip generic legal suffixes, then lowercase for a stable map key
  return rawVendor
    .replace(/\b(inc\.?|llc\.?|ltd\.?|gmbh|pty\.? ltd\.?|corp\.?|holdco)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim()
    .toLowerCase();
}

// ── Slug helpers ─────────────────────────────────────────────────────────────

/**
 * Common English words that are likely registered as unrelated domains.
 * Probing status.open.com or open.statuspage.io would hit some random
 * company's status page, not the intended vendor.
 */
const SLUG_BLOCKLIST = new Set([
  "open", "new", "blue", "red", "first", "data", "app", "apps", "dev",
  "web", "cloud", "labs", "tech", "soft", "corp", "code", "next", "best",
  "pro", "plus", "hub", "net", "core", "one", "now", "good", "real",
  "free", "all", "any", "the", "our", "get", "try", "use",
]);

/** Minimum slug length — single-word slugs shorter than this are too generic. */
const MIN_SLUG_LENGTH = 5;

/**
 * Build slug variants from a vendor name.
 * Slugs that are too short or match common English words are excluded to
 * prevent auto-discovery from hitting unrelated companies' status pages.
 *
 * Examples
 *   "Tempo Software"          → ["tempo", "temposoftware"]
 *   "Easy Agile"              → ["easyagile"]  ("easy" blocked — < 5 chars or blocklist)
 *   "Open Source Consulting"  → []              ("open" blocked, "opensource..." OK)
 *   "K15t"                    → []              (< 5 chars)
 */
function vendorSlugs(vendorName: string): string[] {
  const words = vendorName
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  const first = words[0] ?? "";
  const full = words.join("");
  return [...new Set([first, full].filter(Boolean))].filter(
    (s) => s.length >= MIN_SLUG_LENGTH && !SLUG_BLOCKLIST.has(s),
  );
}

/**
 * Try to discover a working status-page URL for `vendorName`.
 * Returns null if none of the probed candidates responds correctly.
 */
export async function discoverStatusUrl(
  vendorName: string,
): Promise<DiscoveredStatus | null> {
  if (!vendorName) return null;

  const slugs = vendorSlugs(vendorName);

  // For each slug we try the most common status-page hosting patterns:
  //   • Atlassian Statuspage  → /api/v2/status.json
  //   • Instatus              → /summary.json
  //   • Hund / custom         → /index.json
  // We probe .com and .io TLDs; .io is very common for developer-tool vendors.
  const candidates: Array<{ url: string; checkType: CheckType }> = [];
  for (const slug of slugs) {
    for (const tld of ["com", "io"]) {
      candidates.push(
        {
          url: `https://status.${slug}.${tld}/api/v2/status.json`,
          checkType: "statuspage_api",
        },
        {
          url: `https://status.${slug}.${tld}/summary.json`,
          checkType: "statuspage_api",
        },
        {
          url: `https://status.${slug}.${tld}/index.json`,
          checkType: "statuspage_api",
        },
      );
    }
    // Some vendors host at <slug>.statuspage.io
    candidates.push({
      url: `https://${slug}.statuspage.io/api/v2/status.json`,
      checkType: "statuspage_api",
    });
  }

  // Promise.any resolves as soon as the first probe succeeds; if all fail it
  // throws AggregateError which we catch and return null.
  try {
    return await Promise.any(
      candidates.map(async ({ url, checkType }) => {
        const found = await probeUrl(url);
        if (!found) throw new Error("no response");
        return { statusUrl: found, checkType };
      }),
    );
  } catch {
    return null;
  }
}
