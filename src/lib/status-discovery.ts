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

/** Probe one URL — returns the URL + parsed JSON only if it serves a recognisable status-page. */
async function probeUrl(url: string): Promise<{ url: string; json: unknown } | null> {
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
    return { url, json };
  } catch {
    return null;
  }
}

/** Extract the human-readable page name from a statuspage JSON payload. */
function getPageName(json: unknown): string {
  if (!json || typeof json !== "object") return "";
  const j = json as Record<string, unknown>;
  // Instatus / Statuspage: { page: { name: "…" } }
  const page = j.page as Record<string, unknown> | undefined;
  if (typeof page?.name === "string") return page.name;
  // Hund.io JSON:API: { data: { attributes: { name: "…" } } }
  const data = j.data as Record<string, unknown> | undefined;
  const attrs = data?.attributes as Record<string, unknown> | undefined;
  if (typeof attrs?.name === "string") return attrs.name;
  return "";
}

/**
 * Returns true when the status-page JSON's reported page name is plausibly
 * the same company as `vendorName`.
 *
 * We tokenise the vendor name (4+ char tokens, minus generic legal suffixes)
 * and require that the majority of those tokens appear in the page name.
 * This prevents false positives like:
 *   vendor "Catapult Labs" → slug "catapult" → page.name "Catapult" (wrong company)
 *   ↳ "labs" token is missing → majority check fails → rejected
 *
 * When the page name is absent (some Hund.io pages omit it), we allow the
 * match so we don't silently drop valid discoveries.
 */
function vendorPageNameMatch(vendorName: string, json: unknown): boolean {
  const pageName = getPageName(json).toLowerCase();
  if (!pageName) return true; // cannot validate — allow

  const STOP = new Set(["the", "for", "and", "inc", "llc", "ltd", "gmbh", "corp", "software", "apps"]);
  const tokens = vendorName
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOP.has(w));

  if (tokens.length === 0) return true; // nothing to validate

  const matchCount = tokens.filter((t) => pageName.includes(t)).length;
  // For 1-2 tokens: all must match. For 3+: at least 2 must match.
  const minMatches = tokens.length >= 3 ? 2 : tokens.length;
  return matchCount >= minMatches;
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
  // l.startsWith instead of l === because Marketplace vendor name is the long form:
  // "Exalate: Integrations for Jira, Azure DevOps, Zendesk, Salesforce, …"
  if (l.includes("idalko") || l.includes("igo software") || l.startsWith("exalate")) return "exalate";

  // ── draw.io (Seibert Media / JGraph) ────────────────────────────────────
  if (l.includes("seibert") || l.includes("jgraph")) return "seibert media";

  // ── Xblend / Xpand IT (Xray) ────────────────────────────────────────────
  if (l.includes("xblend") || l.includes("xpand it")) return "xblend";

  // ── codefortynine (may appear as "Code Fortynine" with a space) ──────────
  if (l.includes("codefortynine") || l === "code fortynine") return "codefortynine";

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
  // Generic English words commonly registered as unrelated domains
  "open", "new", "blue", "red", "first", "data", "app", "apps", "dev",
  "web", "cloud", "labs", "tech", "soft", "corp", "code", "next", "best",
  "pro", "plus", "hub", "net", "core", "one", "now", "good", "real",
  "free", "all", "any", "the", "our", "get", "try", "use",
  // Additional generic words confirmed to cause false positives
  "release", "catapult", "azure", "aws", "support", "admin", "portal",
  "home", "main", "base", "easy", "smart", "fast", "simple", "magic",
  "super", "quick", "ninja", "rocket", "hero", "boost", "flow", "link",
  "sync", "dash", "grid", "list", "form", "view", "move", "work",
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
  // Each probe also validates that the page name plausibly matches the vendor —
  // this prevents generic slugs (e.g. "release") from matching an unrelated
  // company's status page that happens to be reachable first.
  try {
    return await Promise.any(
      candidates.map(async ({ url, checkType }) => {
        const hit = await probeUrl(url);
        if (!hit) throw new Error("no response");
        if (!vendorPageNameMatch(vendorName, hit.json)) throw new Error("page name mismatch");
        return { statusUrl: hit.url, checkType };
      }),
    );
  } catch {
    return null;
  }
}
