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
import { KNOWN_VENDOR_MAP } from "@/lib/known-vendors";
import { discoverStatusUrl, normalizeVendorName } from "@/lib/status-discovery";
import { resolveStatusUrl } from "@/types";
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

  // ── Call UPM API (paginated) ─────────────────────────────────────────────
  const credentials = Buffer.from(`${email}:${apiToken}`).toString("base64");
  const upmHeaders = {
    Authorization: `Basic ${credentials}`,
    // The UPM API returns 406 if Accept is missing or set to */*.
    Accept: "application/vnd.atl.plugins.installed+json, application/json",
    "Content-Type": "application/json",
    "User-Agent": "NextJS-Jira-Importer/1.0",
  };

  // First page — auth / domain errors must surface here before we continue.
  let firstRes: Response;
  try {
    firstRes = await fetch(`${jiraDomain}/rest/plugins/1.0/?limit=500`, {
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
  const allPlugins: UpmPlugin[] = [...(firstData.plugins ?? [])];

  // Follow pagination links — some Jira Cloud instances cap the first page at
  // 50–100 plugins regardless of the ?limit parameter.
  let nextLink = firstData.links?.next;
  while (nextLink) {
    const nextUrl = nextLink.startsWith("http")
      ? nextLink
      : `${jiraDomain}${nextLink}`;
    try {
      const nextRes = await fetch(nextUrl, {
        method: "GET",
        cache: "no-store",
        headers: upmHeaders,
      });
      if (!nextRes.ok) break;
      const nextData = (await nextRes.json()) as UpmResponse;
      const batch = nextData.plugins ?? [];
      if (batch.length === 0) break;
      allPlugins.push(...batch);
      nextLink = nextData.links?.next;
    } catch {
      break; // Network hiccup on a subsequent page — work with what we have
    }
  }

  console.log(`[jira/import] UPM plugins (all pages): ${allPlugins.length}`);

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

  // Try several known endpoints — Atlassian has silently renamed/moved them
  const CONNECT_ENDPOINTS = [
    `${jiraDomain}/rest/atlassian-connect/1/addons`,
    `${jiraDomain}/rest/plugins/1.0/addons`,          // older alias
  ];

  let connectTotal = 0;

  for (const endpoint of CONNECT_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "GET",
        cache: "no-store",
        headers: upmHeaders,
      });

      const rawText = await res.text();
      console.log(
        `[connect] ${endpoint} → HTTP ${res.status} | body(500)=${rawText.slice(0, 500)}`,
      );

      if (!res.ok) continue;

      let parsed: unknown;
      try { parsed = JSON.parse(rawText); } catch { continue; }

      const addons = parseConnectAddons(parsed);
      console.log(`[connect] parsed ${addons.length} addons from ${endpoint}`);

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

  console.log(`[jira/import] Connect add-ons merged: ${connectTotal} (total combined: ${allPlugins.length})`);

  // ── Inclusion criteria ──────────────────────────────────────────────────
  // Atlassian-made apps that are genuine marketplace integrations.
  // Used as a whitelist when userInstalled is missing but vendor is "Atlassian".
  const ATLASSIAN_VENDOR_WHITELIST = [
    "github for jira",
    "slack for jira",
    "microsoft teams for jira",
    "zoom for jira",
    "google sheets for jira",
    "google drive & docs for jira",
  ];

  // Key-prefix block list for infrastructure plugins that slip through.
  const BLOCKED_KEY_PREFIXES = [
    "com.atlassian.jira.plugins.core",
    "com.atlassian.jira.internal",
    "com.atlassian.jira.dev",
    "com.atlassian.frontend",
    "com.atlassian.troubleshooting",
    "com.atlassian.upm",
    "com.atlassian.oauth",
    "com.atlassian.webhooks",
    "com.atlassian.jwt",
    "com.atlassian.analytics",
    "com.atlassian.applinks",
    "com.atlassian.plugins.document",
    "com.atlassian.plugins.atlassian-connect-plugin",
    "com.atlassian.plugins.rest",
    "com.atlassian.plugins.servlet",
    "com.atlassian.plugins.editor",
    "com.atlassian.auiplugin",
    "com.atlassian.labs.hipchat",
    "com.atlassian.streams",
    "com.atlassian.gadgets",
    "com.atlassian.jira.extra",
    "com.atlassian.confluence.extra",
  ];

  // Name-fragment block list for WAR-bundled modules identifiable by display name.
  const BLOCKED_NAME_FRAGMENTS = [
    "atlassian jira - plugins",
    "atlassian confluence - plugins",
    "atlassian jira - project templates",
    "atlassian jira - administration",
  ];

  const isWhitelisted = (name: string) => {
    const lower = name.toLowerCase();
    return ATLASSIAN_VENDOR_WHITELIST.some((w) => lower.includes(w));
  };

  const isBlockedKey = (key: string) =>
    BLOCKED_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));

  const isBlockedName = (name: string) => {
    const lower = name.toLowerCase();
    return BLOCKED_NAME_FRAGMENTS.some((frag) => lower.includes(frag));
  };

  // ── Debug: dump every plugin before filtering ────────────────────────────
  console.log(`[jira/import] --- RAW UPM DUMP (${allPlugins.length} plugins) ---`);
  allPlugins.forEach((p) => {
    console.log(
      `  [upm] "${p.name ?? ""}" | key="${p.key ?? ""}" | vendor="${p.vendor?.name ?? ""}" | userInstalled=${String(p.userInstalled)}`,
    );
  });
  console.log(`[jira/import] --- END RAW DUMP ---`);

  // ── Inclusion criteria ────────────────────────────────────────────────────
  // NOTE: userInstalled is intentionally NOT used as a filter signal.
  //
  // In Jira Cloud, Atlassian manages plugin lifecycle centrally. Many real
  // marketplace apps (e.g. ScriptRunner by Adaptavist) report userInstalled: false
  // even though the admin explicitly added them from the marketplace.
  //
  // RELIABLE signal: plugin key namespace.
  //   • Virtually every Atlassian system plugin ships under com.atlassian.*
  //   • Third-party apps use their own namespaces (com.onresolve.*, io.tempo.*, etc.)
  //   • Whitelist: Atlassian-built marketplace integrations that use com.atlassian.*

  const userPlugins = allPlugins.filter(
    (p): p is UpmPlugin & { key: string; name: string } => {
      if (!p.key || !p.name) return false;

      // Always skip confirmed infrastructure key/name patterns
      if (isBlockedKey(p.key)) return false;
      if (isBlockedName(p.name)) return false;

      // Exclude the entire com.atlassian.* namespace — Atlassian system infrastructure.
      // Whitelist passes through Atlassian-built marketplace integrations.
      if (p.key.startsWith("com.atlassian.") && !isWhitelisted(p.name)) return false;

      return true;
    },
  );

  console.log(
    `[jira/import] after filter: ${userPlugins.length} / ${allPlugins.length} kept`,
  );
  userPlugins.forEach((p) => {
    console.log(
      `  [kept] "${p.name}" | key="${p.key}" | userInstalled=${String(p.userInstalled)}`,
    );
  });

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
    try {
      const mpRes = await fetch(
        `https://marketplace.atlassian.com/rest/2/addons/${encodeURIComponent(
          plugin.key,
        )}`,
        {
          cache: "no-store",
          signal: AbortSignal.timeout(3000),
          headers: { Accept: "application/json" },
        },
      );
      if (mpRes.ok) {
        const mpData = (await mpRes.json()) as {
          _links?: { logo?: { href?: string } };
        };
        const assetPath = mpData._links?.logo?.href;
        if (assetPath) {
          const assetId = assetPath.split("/").pop();
          if (assetId) {
            return {
              logoUrl: `https://marketplace.atlassian.com/product-listing/files/${assetId}?width=72&height=72`,
              onMarketplace: true,
            };
          }
        }
        // Found in marketplace but no logo asset
        return { logoUrl: undefined, onMarketplace: true };
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
    return n.includes("flexible") || n.includes("osci");
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
      console.log(
        `[MAP CHECK] App: ${appName} | Vendor: ${rawVendor} | URL: ${
          result.statusUrl || "none"
        } | source: ${result.statusSource} | marketplace: ${String(result.onMarketplace)}`,
      );
      return result;
    };

    /** If we already fetched a logo in the KNOWN_VENDOR_MAP branch, reuse it. */
    let precachedLogoRes: LogoResolution | undefined;

    // Forge / Ecosystem serverless: ARI or URN app keys — shared infra status
    if (isForgeServerlessKey(plugin.key)) {
      const { logoUrl } = await resolvePluginLogo(plugin);
      console.log(
        `[import:forge] "${appName}" | key starts with ${JSON.stringify(
          plugin.key.slice(0, 48),
        )}… → ${FORGE_DEVELOPER_STATUS_URL}`,
      );
      return logMapCheck({
        logoUrl,
        statusUrl: FORGE_DEVELOPER_STATUS_URL,
        checkType: "statuspage_api",
        statusSource: "serverless",
      });
    }

    const normalizedKey = normalizeVendorName(rawVendor);
    const mappedValue = Object.prototype.hasOwnProperty.call(
      KNOWN_VENDOR_MAP,
      normalizedKey,
    )
      ? KNOWN_VENDOR_MAP[normalizedKey]
      : undefined;

    const assignedPreview =
      !Object.prototype.hasOwnProperty.call(KNOWN_VENDOR_MAP, normalizedKey)
        ? "None (Fallback to resolveStatusUrl or Auto-Discovery)"
        : mappedValue === null
          ? "NONE (blacklisted – no public status page)"
          : String(mappedValue);

    console.log("--- [DEBUG IMPORT] ---");
    console.log(`App Name: "${appName}"`);
    console.log(`Original Vendor: "${rawVendor}"`);
    console.log(`Normalized Key: "${normalizedKey}"`);
    console.log(`Assigned URL: ${assignedPreview}`);

    // ── Priority 1: KNOWN_VENDOR_MAP (lowercase keys) ─────────────────────
    if (normalizedKey in KNOWN_VENDOR_MAP) {
      const entry = KNOWN_VENDOR_MAP[normalizedKey];
      const logoRes = await resolvePluginLogo(plugin);

      if (entry === null) {
        return logMapCheck({
          logoUrl: logoRes.logoUrl,
          statusUrl: "",
          checkType: "custom",
          statusSource: "none",
        });
      }
      // Do not map these product lines to Tempo (bad UPM vendor strings)
      if (isTempoStatusUrl(entry) && isTempoBlockedByAppName(appName)) {
        console.log(
          `[import] Skipping KNOWN Tempo URL for app="${appName}" (flexible/osci guard)`,
        );
        precachedLogoRes = logoRes;
        // fall through to priority 2/3
      } else {
        return logMapCheck({
          logoUrl: logoRes.logoUrl,
          statusUrl: entry,
          checkType: "statuspage_api",
          statusSource: "map",
        });
      }
    }

    // ── Priority 2: PRODUCT_RULES + VENDOR_STATUS_MAP (types/index.ts) ─────
    let knownStatus = resolveStatusUrl(appName, rawVendor);
    if (
      knownStatus &&
      isTempoStatusUrl(knownStatus.statusUrl) &&
      isTempoBlockedByAppName(appName)
    ) {
      console.log(
        `[import] Dropping resolveStatusUrl Tempo match for app="${appName}" (flexible/osci guard)`,
      );
      knownStatus = null;
    }

    // ── Priority 3: Auto-discovery — use normalized key for URL slug guesses ─
    const [logoRes, discoveredStatus] = await Promise.all([
      precachedLogoRes !== undefined
        ? Promise.resolve(precachedLogoRes)
        : resolvePluginLogo(plugin),
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

  // Process in batches of 5 — each slot may make up to ~13 outbound requests
  // (1 Marketplace CDN + up to 12 status-page probes) so we keep concurrency low.
  const BATCH_SIZE = 5;
  const resolutions: PluginResolution[] = [];
  for (let i = 0; i < userPlugins.length; i += BATCH_SIZE) {
    const batch = userPlugins.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(resolvePlugin));
    resolutions.push(...batchResults);
  }

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
  });
}
