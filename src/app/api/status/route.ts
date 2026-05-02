// Force Next.js to never cache this route — status checks must always be live.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

import { NextResponse } from "next/server";
import type {
  AppHealthStatus,
  CheckType,
  HealthCheckResult,
  RegisteredApp,
} from "@/types";
import { discoverStatusUrl, normalizeVendorName } from "@/lib/status-discovery";

const REQUEST_TIMEOUT_MS = 8000;

// ── Type guards ─────────────────────────────────────────────────────────────

function isRegisteredApp(value: unknown): value is RegisteredApp {
  if (!value || typeof value !== "object") return false;
  const app = value as Partial<RegisteredApp>;
  return (
    typeof app.id === "string" &&
    typeof app.appName === "string" &&
    typeof app.vendorName === "string" &&
    typeof app.statusUrl === "string" &&
    isCheckType(app.checkType)
  );
}

function isCheckType(value: unknown): value is CheckType {
  return value === "statuspage_api" || value === "http_ping" || value === "custom";
}

// ── Format detection ────────────────────────────────────────────────────────

/**
 * Atlassian Statuspage URLs always contain "/api/v2/".
 * Instatus / Hund.io URLs look like "/summary.json" or "/index.json" (no "/api/v2/").
 */
function isStatuspageUrl(url: string): boolean {
  return url.includes("/api/v2/");
}

// ── Unified status normalizer ───────────────────────────────────────────────

/**
 * Converts raw component status strings from EITHER Statuspage OR Instatus
 * into our three-state health model.
 *
 * Statuspage uses lowercase+underscore:  "operational", "degraded_performance",
 *                                        "partial_outage", "major_outage"
 * Instatus uses UPPERCASE (no separator): "OPERATIONAL", "DEGRADED",
 *                                         "PARTIALOUTAGE", "MAJOROUTAGE"
 *
 * We normalise by lowercasing and stripping non-alpha chars before switching.
 */
function normalizeComponentStatus(raw: string): AppHealthStatus {
  const s = raw.toLowerCase().replace(/[^a-z]/g, "");
  switch (s) {
    case "operational":
    case "up":
      return "operational";
    case "degradedperformance":
    case "degraded":
    case "undermaintenance":
      return "degraded";
    case "partialoutage": // classified as outage per product requirement
    case "majoroutage":
    case "outage":
    case "down":
      return "outage";
    default:
      return "degraded";
  }
}

// ── Statuspage types & helpers ──────────────────────────────────────────────

interface StatuspageComponent {
  id?: string;
  name?: string;
  status?: string;
  group?: boolean;
}

interface StatuspageSummary {
  status?: { indicator?: string; description?: string };
  components?: StatuspageComponent[];
}

function globalFromStatuspageIndicator(indicator?: string): AppHealthStatus {
  switch (indicator) {
    case "none":      return "operational";
    case "minor":     return "degraded";
    case "major":
    case "critical":  return "outage";
    default:          return "degraded";
  }
}

// ── Instatus types & helpers ────────────────────────────────────────────────

interface InstatusComponent {
  id?: string;
  name?: string;
  status?: string; // "OPERATIONAL" | "DEGRADED" | "PARTIALOUTAGE" | "MAJOROUTAGE" | "UNDERMAINTENANCE"
}

interface InstatusSummary {
  page?: { status?: string }; // "UP" | "HASISSUES" | "UNDERMAINTENANCE"
  activeIncidents?: unknown[];
  activeMaintenances?: unknown[];
  components?: InstatusComponent[];
}

function globalFromInstatus(payload: InstatusSummary): AppHealthStatus {
  const hasIncidents = (payload.activeIncidents?.length ?? 0) > 0;
  if (hasIncidents) return "outage";

  const pageStatus = payload.page?.status?.toUpperCase() ?? "";
  if (pageStatus === "UP") return "operational";
  if (pageStatus === "UNDERMAINTENANCE") return "degraded";
  return "degraded";
}

// ── Shared component matcher ────────────────────────────────────────────────

/**
 * Generic stop-words excluded from app-name token extraction.
 * These words are too common to be useful distinguishing tokens.
 */
const STOP_WORDS = new Set([
  "for", "the", "and", "app", "apps", "cloud", "server", "data", "by",
]);

/**
 * Platform words captured separately via the `platform` detection path.
 * Keeping them out of `appTokens` prevents a component like "BigPicture for Jira"
 * from scoring `hasToken = true` when checking the app "BigGantt for Jira" —
 * because "jira" would otherwise appear in both token sets and create a false match.
 */
const PLATFORM_WORDS = new Set(["jira", "confluence"]);

/**
 * Generic component names present on almost every status page that have
 * nothing to do with specific Marketplace apps.
 */
const GENERIC_COMPONENT_RE =
  /^(website|support\s*portal|cdn|infrastructure|blog|docs|documentation|marketing|api|all\s*systems|platform|core|status)$/i;

/**
 * Score a component name against the given app name.
 * Higher score = better match. Returns 0 when the component should be excluded.
 *
 * Rules:
 *   - A component MUST contain at least one specific app-name keyword to score
 *     above 0.  A component that only shares a platform word ("jira") with the
 *     app name is NOT a valid match and returns 0 — this prevents every
 *     "* for Jira" entry on a unified status page from being treated as relevant.
 *
 * Scoring when a keyword matches:
 *   base  +5   keyword from app name found in component name
 *   bonus +10  component also mentions the target platform ("jira"/"confluence")
 *   bonus +3   both keyword AND platform match (double-specificity reward)
 */
function scoreComponent(componentName: string, appName: string): number {
  const cn = componentName.toLowerCase();
  const nameLower = appName.toLowerCase();

  const platform =
    nameLower.includes("confluence") ? "confluence" :
    nameLower.includes("jira")       ? "jira"       : null;

  // Exclude platform words — they are captured by the `hasPlatform` path.
  // Including them in appTokens would let any component mentioning "jira"
  // incorrectly satisfy `hasToken`, producing false high scores.
  const appTokens = appName
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w) && !PLATFORM_WORDS.has(w));

  const hasToken    = appTokens.some((t) => cn.includes(t));

  // Gate: no specific keyword match → not a valid component for this app.
  // Prevents "Issue Matrix for Jira" from matching when looking for "BigGantt".
  if (!hasToken) return 0;

  const hasPlatform = platform ? cn.includes(platform) : false;

  let s = 5;                              // base: specific keyword matched
  if (hasPlatform)          s += 10;     // also matches the right platform
  if (hasPlatform && hasToken) s += 3;   // double-specificity bonus

  return s;
}

/**
 * Find the component most relevant to `appName` from a list of normalised
 * components. Returns undefined when nothing scores above zero.
 */
function findBestComponent(
  appName: string,
  components: Array<{ name: string; rawStatus: string }>,
): { name: string; rawStatus: string } | undefined {
  return components
    .filter((c) => !GENERIC_COMPONENT_RE.test(c.name.trim()))
    .map((c) => ({ c, s: scoreComponent(c.name, appName) }))
    .filter(({ s }) => s > 0)
    .sort((a, b) => b.s - a.s)[0]?.c;
}

/**
 * Unified vendor status pages (e.g. Adaptavist Connect): try to bind the app to a
 * specific component by cleaned name *before* the token scorer, so a product
 * is not downgraded from another product’s component outage.
 */
const MIN_FUZZY_NAME_LEN = 3;

function normalizeForFuzzyNameMatch(name: string): string {
  return name
    .toLowerCase()
    .replace(/\bfor jira\b|\bfor confluence\b|\bfor bitbucket\b/gi, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function findFuzzyNameComponent(
  appName: string,
  components: Array<{ name: string; rawStatus: string }>,
): { name: string; rawStatus: string } | undefined {
  const clean = normalizeForFuzzyNameMatch(appName);
  if (clean.length < MIN_FUZZY_NAME_LEN) return undefined;

  const candidates = components.filter(
    (c) => !GENERIC_COMPONENT_RE.test(c.name.trim()),
  );

  for (const c of candidates) {
    const compNorm = normalizeForFuzzyNameMatch(c.name);
    if (compNorm.length < 2) continue;
    if (compNorm.includes(clean)) {
      return c;
    }
    if (clean.includes(compNorm) && compNorm.length >= 4) {
      return c;
    }
  }
  return undefined;
}

// ── Per-format extraction ───────────────────────────────────────────────────

function extractStatuspageStatus(
  appName: string,
  payload: StatuspageSummary,
): { status: AppHealthStatus; message: string } {
  const globalStatus  = globalFromStatuspageIndicator(payload.status?.indicator);
  const globalMessage = payload.status?.description ?? "Statuspage API response";

  const components = (payload.components ?? [])
    .filter((c): c is StatuspageComponent & { name: string } =>
      Boolean(c.name) && !c.group,
    )
    .map((c) => ({ name: c.name, rawStatus: c.status ?? "" }));

  const fuzzy = findFuzzyNameComponent(appName, components);
  if (fuzzy?.rawStatus) {
    return {
      status: normalizeComponentStatus(fuzzy.rawStatus),
      message: `${fuzzy.name}: ${fuzzy.rawStatus.replace(/_/g, " ")}`,
    };
  }

  const best = findBestComponent(appName, components);
  if (best?.rawStatus) {
    return {
      status: normalizeComponentStatus(best.rawStatus),
      message: `${best.name}: ${best.rawStatus.replace(/_/g, " ")}`,
    };
  }

  return { status: globalStatus, message: globalMessage };
}

function extractInstatusStatus(
  appName: string,
  payload: InstatusSummary,
): { status: AppHealthStatus; message: string } {
  const globalStatus = globalFromInstatus(payload);

  const components = (payload.components ?? [])
    .filter((c): c is InstatusComponent & { name: string } => Boolean(c.name))
    .map((c) => ({ name: c.name, rawStatus: c.status ?? "" }));

  const best = findBestComponent(appName, components);
  if (best?.rawStatus) {
    return {
      status:  normalizeComponentStatus(best.rawStatus),
      message: `${best.name}: ${best.rawStatus}`,
    };
  }
  return {
    status:  globalStatus,
    message: `Page: ${payload.page?.status ?? "unknown"}`,
  };
}

/**
 * Normalize JSON:API / Hund.io `state` strings to our AppHealthStatus.
 * Hund uses values like "operational", "degraded", "outage", "maintenance".
 */
function normalizeJsonApiState(state: string): AppHealthStatus {
  if (state === "operational" || state === "up" || state === "ok") return "operational";
  if (state.includes("degraded") || state.includes("issues") || state.includes("minor")) return "degraded";
  if (state.includes("outage") || state.includes("down") || state.includes("major")) return "outage";
  if (state.includes("maintenance")) return "degraded";
  return "degraded";
}

/**
 * Format-agnostic dispatcher — inspects the payload shape and picks the right
 * parser. This handles edge-case endpoints like draw.io's `index.json` whose
 * format is not predictable from the URL alone.
 *
 * Detection priority:
 *   1. Has `status.indicator`  → Atlassian Statuspage
 *   2. Has `page.status`       → Instatus
 *   3. Has `status.description`→ description-based fallback (index.json etc.)
 *   4. Default                 → degraded
 */
function extractAnyStatus(
  appName: string,
  payload: unknown,
): { status: AppHealthStatus; message: string } {
  const p = payload as Record<string, unknown>;
  const statusObj = p.status as Record<string, unknown> | undefined;
  const pageObj   = p.page   as Record<string, unknown> | undefined;

  // 1. Atlassian Statuspage — has status.indicator
  if (statusObj?.indicator !== undefined) {
    return extractStatuspageStatus(appName, payload as StatuspageSummary);
  }

  // 2. Instatus — has page.status
  if (pageObj?.status !== undefined) {
    return extractInstatusStatus(appName, payload as InstatusSummary);
  }

  // 3. Instatus export / JSON:API format (draw.io index.json)
  //    Exact schema confirmed from live payload:
  //      data.attributes.aggregate_state         — global status
  //      included[].type === "status_page_resource"
  //        .attributes.public_name               — component display name
  //        .attributes.status                    — component status string
  const dataField     = p.data     as Record<string, unknown> | undefined;
  const includedField = p.included as unknown[] | undefined;

  if (dataField !== undefined && includedField !== undefined) {
    const attrs        = dataField.attributes as Record<string, unknown> | undefined;
    const aggregateRaw = (attrs?.aggregate_state ?? attrs?.state ?? dataField.status ?? "") as string;
    const globalStatus = normalizeJsonApiState(aggregateRaw.toLowerCase());

    // Determine platform keyword for component matching
    const nameLower = appName.toLowerCase();
    const platform  =
      nameLower.includes("confluence") ? "confluence" :
      nameLower.includes("jira")       ? "jira"       : null;

    // Only look at status_page_resource entries — these are the real app components.
    // Other types (e.g. "status_page", "account") are structural metadata.
    const resources = (Array.isArray(includedField) ? includedField : []).filter(
      (item) => (item as Record<string, unknown>).type === "status_page_resource",
    );

    let matched: { name: string; status: string } | undefined;
    if (platform) {
      for (const item of resources) {
        const r     = item as Record<string, unknown>;
        const rAttr = r.attributes as Record<string, unknown> | undefined;
        const name  = (rAttr?.public_name ?? rAttr?.name ?? "") as string;
        if (name.toLowerCase().includes(platform)) {
          matched = { name, status: (rAttr?.status ?? "") as string };
          break;
        }
      }
    }

    if (matched) {
      return {
        status: normalizeJsonApiState(matched.status.toLowerCase()),
        message: `${matched.name}: ${matched.status}`,
      };
    }

    return { status: globalStatus, message: aggregateRaw || "index.json status" };
  }

  // 4. Description-only fallback (e.g. unknown hybrid schemas)
  const description = (statusObj?.description as string ?? "").toLowerCase();
  if (description) {
    const status: AppHealthStatus =
      description.includes("all systems operational") || description === "operational"
        ? "operational"
        : description.includes("degraded") || description.includes("minor")
        ? "degraded"
        : "outage";
    return { status, message: description };
  }

  // 5. Raw string scan — last resort to avoid false "Outage" when service is fine.
  const raw = JSON.stringify(p).toLowerCase();
  if (raw.includes("operational") && !raw.includes("outage") && !raw.includes("degraded")) {
    return { status: "operational", message: "All systems operational (raw scan)" };
  }

  // 6. Truly unrecognisable
  console.warn(`[status] Unrecognised payload shape for "${appName}"`);
  return { status: "degraded", message: "Unrecognised status page format" };
}

// ── Self-healing helpers ────────────────────────────────────────────────────

/**
 * Returns true when the error is a DNS/network failure (the host doesn't exist
 * or is unreachable) rather than an HTTP-level error (the service is down but
 * the host resolved fine).
 *
 * These error codes signal that the URL itself is stale — the vendor probably
 * moved their status page — so we should try auto-discovery rather than
 * reporting a service outage.
 */
function isDnsOrConnectionError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes("enotfound") ||       // DNS lookup failed
    msg.includes("econnrefused") ||    // host refuses connection
    msg.includes("econnreset") ||      // connection reset mid-way
    msg.includes("failed to fetch") || // browser-side DNS failure
    msg.includes("network error") ||
    msg.includes("getaddrinfo") ||     // Node.js DNS rejection
    msg.includes("name or service not known")
  );
}

// ── Health check ────────────────────────────────────────────────────────────

async function checkAppHealth(app: RegisteredApp): Promise<HealthCheckResult> {
  const start = Date.now();

  if (!app.statusUrl) {
    return {
      appId:         app.id,
      status:        "degraded",
      checkedAt:     new Date().toISOString(),
      responseTimeMs: null,
      message:       "No status URL configured for this vendor.",
    };
  }

  try {
    // Statuspage: URLs may end with either status.json or summary.json.
    //   summary.json includes components[] needed for per-app matching.
    //   We upgrade status.json → summary.json here so old localStorage entries
    //   (which still carry status.json) are handled transparently.
    //   summary.json URLs pass through unchanged (regex simply won't match).
    // Instatus / Hund.io: no /api/v2/ prefix — use URL as-is.
    const isStatuspage = isStatuspageUrl(app.statusUrl);
    const fetchUrl = isStatuspage
      ? app.statusUrl.replace(/\/api\/v2\/status\.json$/, "/api/v2/summary.json")
      : app.statusUrl;


    const response = await fetch(fetchUrl, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        // Explicitly request JSON — tells CDNs/WAFs this is a data fetch, not a page load
        Accept: "application/json",
        // Mimic a real browser to bypass basic Cloudflare / bot-management challenges
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        Pragma: "no-cache",
      },
    });

    const responseTimeMs = Date.now() - start;

    // ── http_ping ──────────────────────────────────────────────────────────
    if (app.checkType === "http_ping") {
      return {
        appId:         app.id,
        status:        response.ok ? "operational" : "outage",
        checkedAt:     new Date().toISOString(),
        responseTimeMs,
        message:       response.ok
          ? `HTTP ${response.status}`
          : `HTTP error: ${response.status}`,
      };
    }

    // ── statuspage_api (Statuspage or Instatus) ────────────────────────────
    if (app.checkType === "statuspage_api") {
      if (!response.ok) {
        console.error(`[FETCH FAILED] "${app.appName}" | HTTP ${response.status} — skipping parse, returning outage`);
        return {
          appId:         app.id,
          status:        "outage",
          checkedAt:     new Date().toISOString(),
          responseTimeMs,
          message:       `Status API request failed: HTTP ${response.status}`,
        };
      }

      // Guard against CDN/WAF bot challenges that return HTML with 200 OK
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        console.error(
          `[FETCH BLOCKED] "${app.appName}" | content-type="${contentType}" — WAF/CDN returned non-JSON (HTML bot challenge?). url=${fetchUrl}`,
        );
        return {
          appId:          app.id,
          status:         "degraded" as AppHealthStatus,
          checkedAt:      new Date().toISOString(),
          responseTimeMs,
          message:        "Status page blocked request (CDN/WAF challenge). Try again later.",
        };
      }

      const payload = (await response.json()) as unknown;

      // extractAnyStatus auto-detects Statuspage / Instatus / description-only
      // from the payload shape — no URL heuristic needed.
      const { status, message } = extractAnyStatus(app.appName, payload);

      return { appId: app.id, status, checkedAt: new Date().toISOString(), responseTimeMs, message };
    }

    // ── custom / fallback — treat as plain HTTP ping ───────────────────────
    return {
      appId:         app.id,
      status:        response.ok ? "operational" : "outage",
      checkedAt:     new Date().toISOString(),
      responseTimeMs,
      message:       response.ok ? `HTTP ${response.status}` : `HTTP error: ${response.status}`,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);

    // Self-healing: if the host is unreachable (DNS failure, connection refused),
    // the stored URL is likely stale — the vendor moved their status page.
    // Attempt auto-discovery with a 2 s budget per probe, then retry the check
    // with the new URL so this request still returns a real health result.
    if (isDnsOrConnectionError(error) && app.checkType === "statuspage_api") {
      const vendor = normalizeVendorName(app.vendorName);
      console.warn(`[SELF-HEAL] "${app.appName}" DNS failure — trying auto-discovery for vendor "${vendor}"`);
      try {
        const discovered = await discoverStatusUrl(vendor);
        if (discovered && discovered.statusUrl !== app.statusUrl) {
          console.info(`[SELF-HEAL] "${app.appName}" found new URL: ${discovered.statusUrl}`);
          const healedApp: RegisteredApp = {
            ...app,
            statusUrl:  discovered.statusUrl,
            checkType:  discovered.checkType,
          };
          const retryResult = await checkAppHealth(healedApp);
          return {
            ...retryResult,
            updatedStatusUrl:  discovered.statusUrl,
            updatedCheckType:  discovered.checkType,
          };
        }
      } catch {
        // Discovery failed — fall through to the outage result below.
      }
    }

    console.error(`[CRITICAL ERROR] "${app.appName}" | ${msg}`);
    return {
      appId:          app.id,
      status:         "outage",
      checkedAt:      new Date().toISOString(),
      responseTimeMs: Date.now() - start,
      message:        msg,
    };
  }
}

// ── Route handler ───────────────────────────────────────────────────────────

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { apps?: unknown };
    const apps = body.apps;

    if (!Array.isArray(apps) || !apps.every(isRegisteredApp)) {
      return NextResponse.json(
        { error: "Invalid request payload. Expected { apps: RegisteredApp[] }." },
        { status: 400 },
      );
    }

    const results = await Promise.all(apps.map((app) => checkAppHealth(app)));
    return NextResponse.json({ results });
  } catch {
    return NextResponse.json(
      { error: "Failed to process health check request." },
      { status: 500 },
    );
  }
}
