// Force Next.js to never cache this route — credentials and plugin lists
// must always be fetched live.
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";
export const revalidate = 0;

/**
 * POST /api/jira/import
 *
 * Securely proxies the Jira Universal Plugin Manager (UPM) API to fetch the
 * list of user-installed apps from a Jira Cloud instance.
 *
 * Why a proxy?
 *   - Keeps the API token out of the browser (sent only in the request body to
 *     our Next.js server, never stored or forwarded to the client).
 *   - Avoids CORS: Jira's UPM endpoint doesn't allow cross-origin browser
 *     requests, but our server-side fetch has no such restriction.
 *
 * UPM API shape (GET /rest/plugins/1.0/):
 *   {
 *     "plugins": [
 *       {
 *         "key":           "com.example.plugin",
 *         "name":          "My Plugin",
 *         "userInstalled": true,          // false for Atlassian system plugins
 *         "enabled":       true,
 *         "vendor":        { "name": "Example Vendor" },
 *         "links":         { "plugin_logo": "/rest/plugins/1.0/com.example.plugin/icon" }
 *       }
 *     ]
 *   }
 */

import { NextResponse } from "next/server";
import { discoverStatusUrl, normalizeVendorName } from "@/lib/status-discovery";
import { resolveStatusUrl, VENDOR_BLACKLIST } from "@/types";
import type { RegisteredApp } from "@/types";

interface UpmPlugin {
  key?: string;
  name?: string;
  enabled?: boolean;
  userInstalled?: boolean;
  systemPlugin?: boolean;
  vendor?: { name?: string };
  links?: { plugin_logo?: string; plugin_icon?: string };
}

interface UpmResponse {
  plugins?: UpmPlugin[];
  links?: { next?: string; self?: string };
}

interface ImportRequestBody {
  jiraDomain?: string;
  email?: string;
  apiToken?: string;
}

export async function POST(request: Request) {
  // ── Parse & validate body ────────────────────────────────────────────────
  let body: ImportRequestBody;
  try {
    body = (await request.json()) as ImportRequestBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const jiraDomain = (body.jiraDomain ?? "").trim().replace(/\/+$/, "");
  const email = (body.email ?? "").trim();
  const apiToken = (body.apiToken ?? "").trim();

  if (!jiraDomain || !email || !apiToken) {
    return NextResponse.json(
      { error: "jiraDomain, email, and apiToken are all required." },
      { status: 400 },
    );
  }
  if (!jiraDomain.startsWith("https://")) {
    return NextResponse.json(
      { error: "jiraDomain must start with https://" },
      { status: 400 },
    );
  }

  const authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
  const apiBase = jiraDomain;

  // ── Call UPM API (paginated) ─────────────────────────────────────────────
  const upmHeaders = {
    Authorization: authHeader,
    // The UPM API returns 406 if Accept is missing or set to */*.
    Accept: "application/vnd.atl.plugins.installed+json, application/json",
    "Content-Type": "application/json",
    "User-Agent": "NextJS-Jira-Importer/1.0",
  };

  // ── UPM API: OSGi plugins (paginated) ───────────────────────────────────
  const allPlugins: UpmPlugin[] = [];

  let firstRes: Response;
  try {
    firstRes = await fetch(`${apiBase}/rest/plugins/1.0/?limit=500`, {
      method: "GET",
      cache: "no-store",
      headers: upmHeaders,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Network error";
    console.error("[jira/import] fetch failed:", msg);
    return NextResponse.json(
      { error: `Could not reach ${jiraDomain}. Check the URL and try again.` },
      { status: 502 },
    );
  }

  if (!firstRes.ok) {
    const errorBody = await firstRes.text();
    console.error(`[jira/import] UPM error ${firstRes.status}:`, errorBody.slice(0, 300));
    const errorMap: Record<number, string> = {
      401: "Authentication failed. Check your email and API token.",
      403: "Access denied. Jira admin permissions are required.",
      404: "UPM endpoint not found. Make sure this is a valid Jira Cloud URL.",
      406: "Content negotiation failed (406). The UPM API rejected the Accept header.",
    };
    const message = errorMap[firstRes.status] ?? `Jira API returned HTTP ${firstRes.status}: ${errorBody.slice(0, 120)}`;
    return NextResponse.json({ error: message }, { status: firstRes.status });
  }

  const firstData = (await firstRes.json()) as UpmResponse;
  allPlugins.push(...(firstData.plugins ?? []));

  let nextLink = firstData.links?.next;
  while (nextLink) {
    const nextUrl = nextLink.startsWith("http") ? nextLink : `${apiBase}${nextLink}`;
    try {
      const nextRes = await fetch(nextUrl, { method: "GET", cache: "no-store", headers: upmHeaders });
      if (!nextRes.ok) break;
      const nextData = (await nextRes.json()) as UpmResponse;
      const batch = nextData.plugins ?? [];
      if (batch.length === 0) break;
      allPlugins.push(...batch);
      nextLink = nextData.links?.next;
    } catch {
      break;
    }
  }


  // ── Also fetch Atlassian Connect add-ons ─────────────────────────────────
  // The UPM endpoint (/rest/plugins/1.0/) only returns OSGi-bundled plugins.
  // Modern marketplace apps (ScriptRunner, Tempo, Zephyr, BigPicture, etc.)
  // are built on the Atlassian Connect framework and live in a completely
  // separate registry accessible via /rest/atlassian-connect/1/addons.
  // We merge both lists and deduplicate by key so nothing is double-counted.

  interface ConnectAddon {
    key?: string;
    name?: string;
    state?: string;
    vendor?: { name?: string; url?: string };
  }
  interface ConnectResponse {
    addons?: ConnectAddon[];
    pageSize?: number;
    start?: number;
    size?: number;
  }

  const seenKeys = new Set(allPlugins.map((p) => p.key).filter(Boolean));

  // Helper: normalise a Connect API response that could be an object OR a bare array
  const parseConnectAddons = (raw: unknown): ConnectAddon[] => {
    if (Array.isArray(raw)) return raw as ConnectAddon[];
    if (raw && typeof raw === "object") {
      const obj = raw as Record<string, unknown>;
      if (Array.isArray(obj.addons)) return obj.addons as ConnectAddon[];
      if (Array.isArray(obj.plugins)) return obj.plugins as ConnectAddon[];
    }
    return [];
  };

  const CONNECT_ENDPOINTS = [
    `${jiraDomain}/rest/atlassian-connect/1/addons`,
    `${jiraDomain}/rest/plugins/1.0/addons`,
  ];

  let connectTotal = 0;
  let connectApiBlocked = false;
  let connectLastStatus = 0;

  for (const endpoint of CONNECT_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "GET",
        cache: "no-store",
        headers: upmHeaders,
      });

      connectLastStatus = res.status;
      const rawText = await res.text();

      if (res.status === 403 || res.status === 401) {
        connectApiBlocked = true;
        continue;
      }
      if (!res.ok) continue;

      let parsed: unknown;
      try { parsed = JSON.parse(rawText); } catch { continue; }

      const addons = parseConnectAddons(parsed);

      for (const addon of addons) {
        if (!addon.key || !addon.name) continue;
        if (seenKeys.has(addon.key)) continue;
        seenKeys.add(addon.key);
        allPlugins.push({
          key: addon.key,
          name: addon.name,
          enabled: addon.state == null || addon.state.toUpperCase() === "ENABLED",
          userInstalled: true,
          vendor: addon.vendor ? { name: addon.vendor.name } : undefined,
        });
        connectTotal++;
      }

      // If we got results from this endpoint, no need to try the next
      if (connectTotal > 0) break;
    } catch (err) {
      console.warn(`[connect] ${endpoint} threw:`, err);
    }
  }


  // ── Inclusion criteria ────────────────────────────────────────────────────
  // The UPM API (with Accept: application/vnd.atl.plugins.installed+json) marks
  // every plugin the admin explicitly installed from the Marketplace with
  // userInstalled: true. Atlassian's own system infrastructure is false.
  // This is the canonical, supported signal — no key-prefix heuristics needed.
  const userPlugins = allPlugins.filter(
    (p): p is UpmPlugin & { key: string; name: string } => {
      if (!p.key || !p.name) return false;
      return p.userInstalled === true;
    },
  );


  // ── Per-plugin resolver (logo + status) ─────────────────────────────────
  // Each plugin needs two things resolved asynchronously:
  //   1. A public logo URL via the Marketplace CDN
  //   2. A status-page URL (from our map, or auto-discovered)
  //
  // We run both in parallel per plugin, then batch the plugins at BATCH_SIZE
  // to avoid 429s from external APIs.

  /** Atlassian developer platform / Forge & Connect infra (shared by serverless apps). */
  const FORGE_DEVELOPER_STATUS_URL =
    "https://developer.status.atlassian.com/api/v2/summary.json";

  function isForgeServerlessKey(key: string): boolean {
    return (
      key.startsWith("ari:cloud:ecosystem::app/") ||
      key.startsWith("urn:app:")
    );
  }

  interface PluginResolution {
    logoUrl: string | undefined;
    /** true when the plugin key was found on the Atlassian Marketplace API. */
    onMarketplace: boolean;
    statusUrl: string;
    checkType: import("@/types").CheckType;
    statusSource: "map" | "discovered" | "none" | "serverless";
  }

  interface LogoResolution {
    logoUrl: string | undefined;
    onMarketplace: boolean;
  }

  async function resolvePluginLogo(
    plugin: UpmPlugin & { key: string; name: string },
  ): Promise<LogoResolution> {
    /** Extract a CDN logo URL from a raw marketplace addon payload. */
    function extractLogoUrl(
      payload: unknown,
    ): string | undefined {
      const data = payload as {
        _embedded?: { logo?: { image?: string } };
        _links?: { logo?: { href?: string } };
      };
      // Prefer the pre-built CDN URL from _embedded (no reconstruction needed)
      const direct = data._embedded?.logo?.image;
      if (direct) return direct;
      // Fall back to constructing from the asset href
      const assetId = data._links?.logo?.href?.split("/").pop();
      return assetId
        ? `https://marketplace.atlassian.com/product-listing/files/${assetId}?width=72&height=72`
        : undefined;
    }

    try {
      const mpRes = await fetch(
        `https://marketplace.atlassian.com/rest/2/addons/${encodeURIComponent(plugin.key)}`,
        {
          cache: "no-store",
          signal: AbortSignal.timeout(3000),
          headers: { Accept: "application/json" },
        },
      );
      if (mpRes.ok) {
        const logoUrl = extractLogoUrl(await mpRes.json());
        return { logoUrl, onMarketplace: true };
      }

      // Key not found on marketplace (plugin may have been rekeyed, e.g.
      // com.idalko.exalate → com.exalate.jiranode). Try a name-based search
      // as fallback and match on exact plugin name.
      if (mpRes.status === 404) {
        const searchRes = await fetch(
          `https://marketplace.atlassian.com/rest/2/addons?text=${encodeURIComponent(plugin.name)}&limit=5`,
          {
            cache: "no-store",
            signal: AbortSignal.timeout(3000),
            headers: { Accept: "application/json" },
          },
        );
        if (searchRes.ok) {
          const searchData = (await searchRes.json()) as {
            _embedded?: { addons?: unknown[] };
          };
          const addons = searchData._embedded?.addons ?? [];
          const nameLower = plugin.name.toLowerCase();
          const match = addons.find((a) => {
            const mpName = (a as { name?: string }).name?.toLowerCase() ?? "";
            // Accept exact match OR marketplace name that starts with the UPM name
            // (e.g. UPM "Exalate" matches MP "Exalate: Integrations for Jira, ...")
            return mpName === nameLower || mpName.startsWith(nameLower + ":");
          });
          if (match) {
            const logoUrl = extractLogoUrl(match);
            if (logoUrl) return { logoUrl, onMarketplace: true };
          }
        }
      }
    } catch {
      // Marketplace unreachable / timed out — fall through
    }

    // Not found in marketplace — fall back to absolute Jira-domain URL
    const rawLogo =
      plugin.links?.plugin_logo ?? plugin.links?.plugin_icon ?? "";
    const logoUrl = rawLogo
      ? rawLogo.startsWith("http")
        ? rawLogo
        : `${jiraDomain}/${rawLogo.replace(/^\/+/, "")}`
      : undefined;
    return { logoUrl, onMarketplace: false };
  }

  function isTempoStatusUrl(u: string): boolean {
    return u.includes("status.tempo.io");
  }

  /**
   * App names that must never be forced onto Tempo’s status page (false positives
   * from UPM or fuzzy vendor matching).
   */
  function isTempoBlockedByAppName(appName: string): boolean {
    const n = appName.toLowerCase();
    return (
      n.includes("flexible") ||
      n.includes("osci") ||
      n.includes("sumup") ||
      n.includes("structure")
    );
  }

  async function resolvePlugin(
    plugin: UpmPlugin & { key: string; name: string },
  ): Promise<PluginResolution> {
    // Remapped status URL and source for this plugin only (defensive default before any branch).
    let finalStatusUrl: string | null = null;
    let statusSource: PluginResolution["statusSource"] = "none";
    // Fresh locals every invocation (each plugin is independent — no cross-plugin state).
    const appName = plugin.name;
    const rawVendor = plugin.vendor?.name ?? "Unknown";

    // logMapCheck accepts everything except onMarketplace — it derives that from
    // the logoUrl so all existing return sites don't need updating.
    const logMapCheck = (r: Omit<PluginResolution, "onMarketplace">) => {
      const result: PluginResolution = {
        ...r,
        onMarketplace:
          r.logoUrl?.startsWith(
            "https://marketplace.atlassian.com/product-listing/files/",
          ) === true,
      };
      finalStatusUrl = result.statusUrl ? result.statusUrl : null;
      statusSource = result.statusSource;
      return result;
    };

    const normalizedKey = normalizeVendorName(rawVendor);

    // Forge / Ecosystem serverless: ARI or URN app keys.
    // Prefer the vendor's own status page when one is known — some known vendors
    // (e.g. Appfire) publish Forge apps but have their own status infrastructure.
    // Fall back to the shared Atlassian developer platform page only when no
    // vendor-specific page exists.
    if (isForgeServerlessKey(plugin.key)) {
      const vendorStatus = !VENDOR_BLACKLIST.has(normalizedKey)
        ? resolveStatusUrl(appName, normalizedKey)
        : null;
      const effectiveVendorStatus =
        vendorStatus &&
        isTempoStatusUrl(vendorStatus.statusUrl) &&
        isTempoBlockedByAppName(appName)
          ? null
          : vendorStatus;

      const { logoUrl } = await resolvePluginLogo(plugin);
      if (effectiveVendorStatus) {
        return logMapCheck({
          logoUrl,
          statusUrl: effectiveVendorStatus.statusUrl,
          checkType: effectiveVendorStatus.checkType,
          statusSource: "map",
        });
      }
      return logMapCheck({
        logoUrl,
        statusUrl: FORGE_DEVELOPER_STATUS_URL,
        checkType: "statuspage_api",
        statusSource: "serverless",
      });
    }

    // ── Priority 1: Blacklist — vendor has no public status page ─────────────
    if (VENDOR_BLACKLIST.has(normalizedKey)) {
      const { logoUrl } = await resolvePluginLogo(plugin);
      return logMapCheck({ logoUrl, statusUrl: "", checkType: "custom", statusSource: "none" });
    }

    // ── Priority 2: PRODUCT_RULES + VENDOR_STATUS_MAP (types/index.ts) ──────
    // Pass the normalized key so M&A aliases (e.g. "SoftwarePlant" → "appfire")
    // resolve correctly against the lowercase VENDOR_STATUS_MAP keys.
    let knownStatus = resolveStatusUrl(appName, normalizedKey);
    if (
      knownStatus &&
      isTempoStatusUrl(knownStatus.statusUrl) &&
      isTempoBlockedByAppName(appName)
    ) {
      knownStatus = null;
    }

    // ── Priority 3: Auto-discovery — use normalized key for URL slug guesses ─
    const [logoRes, discoveredStatus] = await Promise.all([
      resolvePluginLogo(plugin),
      knownStatus ? Promise.resolve(null) : discoverStatusUrl(normalizedKey),
    ]);
    const logoUrl = logoRes.logoUrl;

    if (knownStatus) {
      return logMapCheck({
        logoUrl,
        statusUrl: knownStatus.statusUrl,
        checkType: knownStatus.checkType,
        statusSource: "map",
      });
    }
    if (discoveredStatus) {
      if (
        isTempoStatusUrl(discoveredStatus.statusUrl) &&
        isTempoBlockedByAppName(appName)
      ) {
        return logMapCheck({
          logoUrl,
          statusUrl: "",
          checkType: "custom",
          statusSource: "none",
        });
      }
      return logMapCheck({
        logoUrl,
        statusUrl: discoveredStatus.statusUrl,
        checkType: discoveredStatus.checkType,
        statusSource: "discovered",
      });
    }
    return logMapCheck({
      logoUrl,
      statusUrl: "",
      checkType: "custom",
      statusSource: "none",
    });
  }

  // Sliding-window concurrency pool — keeps CONCURRENCY slots active at all times.
  // Map-hit plugins finish quickly and immediately pick up the next slot; only
  // discovery plugins (12 parallel probes, 2 s timeout each) hold a slot longer.
  // This is faster than a fixed batch loop where fast plugins idle while waiting
  // for the slowest task in their batch to complete.
  const CONCURRENCY = 15;
  const resolutions: PluginResolution[] = new Array(userPlugins.length);
  let nextPluginIdx = 0;
  async function runWorker(): Promise<void> {
    while (nextPluginIdx < userPlugins.length) {
      const idx = nextPluginIdx++;
      resolutions[idx] = await resolvePlugin(userPlugins[idx]!);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, userPlugins.length) }, runWorker),
  );

  // ── Build final app objects ───────────────────────────────────────────────
  // statusSource is included in the response so the dialog can show per-app
  // badges, but it is not part of RegisteredApp so it will be stripped on import.
  const apps = userPlugins.map((plugin, idx) => {
    const r = resolutions[idx]!;
    const isServerless = r.statusSource === "serverless";
    return {
      id: plugin.key,
      appName: plugin.name,
      vendorName: isServerless
        ? `${plugin.vendor?.name ?? "Unknown"} (Serverless)`
        : (plugin.vendor?.name ?? "Unknown"),
      checkType: r.checkType,
      statusUrl: r.statusUrl,
      logoUrl: r.logoUrl,
      statusSource: r.statusSource,
      onMarketplace: r.onMarketplace,
    };
  });

  const mappedCount = apps.filter((a) => a.statusSource === "map").length;
  const discoveredCount = apps.filter(
    (a) => a.statusSource === "discovered",
  ).length;
  const serverlessCount = apps.filter(
    (a) => a.statusSource === "serverless",
  ).length;
  const marketplaceCount = apps.filter((a) => a.onMarketplace).length;

  return NextResponse.json({
    apps,
    total: apps.length,
    mappedCount,
    discoveredCount,
    serverlessCount,
    marketplaceCount,
    connectApiBlocked,
  });
}
