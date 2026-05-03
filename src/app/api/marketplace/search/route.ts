/**
 * Proxy for the Atlassian Marketplace REST API v2.
 *
 * Why a proxy?
 *   Direct browser fetches to marketplace.atlassian.com are blocked by CORS.
 *   This Route Handler runs on the Next.js server, bypassing CORS entirely.
 *
 * Key difference from naive implementations:
 *   The Atlassian Marketplace REST API uses the `text` parameter for full-text
 *   search — NOT `q`. Using `text` produces the same relevance-ranked results
 *   as the official Marketplace website.
 *
 * HAL+JSON shape returned by Atlassian:
 *   {
 *     "_embedded": {
 *       "addons": [
 *         {
 *           "key": "com.mxgraph.confluence.mxgraph",
 *           "name": "draw.io Diagrams for Confluence",
 *           "_embedded": { "vendor": { "name": "Seibert Media" } },
 *           "_links":    { "logo":   { "href": "/rest/2/addons/com.mxgraph.../icon" } }
 *         }
 *       ]
 *     }
 *   }
 */

import { NextResponse } from "next/server";
import { resolveStatusUrl, VENDOR_BLACKLIST, type MarketplaceSearchItem } from "@/types";
import { discoverStatusUrl, normalizeVendorName } from "@/lib/status-discovery";

const MARKETPLACE_BASE = "https://marketplace.atlassian.com";

// ── In-memory search cache ────────────────────────────────────────────────────
// Keyed by "query:limit". TTL 60 s — Marketplace results don't change by the
// second, and repeated/backspace queries should be instant for the user.
const searchCache = new Map<string, { items: MarketplaceSearchItem[]; ts: number }>();
const SEARCH_CACHE_TTL_MS = 60_000;
const SEARCH_CACHE_MAX = 50;

function getCachedSearch(key: string): MarketplaceSearchItem[] | null {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > SEARCH_CACHE_TTL_MS) { searchCache.delete(key); return null; }
  return entry.items;
}

function setCachedSearch(key: string, items: MarketplaceSearchItem[]): void {
  if (searchCache.size >= SEARCH_CACHE_MAX) {
    // Evict the oldest entry
    let oldestKey = "";
    let oldestTs = Infinity;
    for (const [k, v] of searchCache) {
      if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; }
    }
    if (oldestKey) searchCache.delete(oldestKey);
  }
  searchCache.set(key, { items, ts: Date.now() });
}

/**
 * Re-rank items by text similarity BEFORE returning to the client.
 *
 * Atlassian's default order is install-count relevance, which means a query
 * like "draw" can bury "draw.io" behind unrelated high-install apps.
 *
 * Score (lower = higher priority, stable sort preserves API order within ties):
 *   0 — exact name match        ("draw"      → "Draw")
 *   1 — name starts with query  ("draw"      → "draw.io Diagrams")
 *   2 — name contains query     ("diagram"   → "draw.io Diagrams")
 *   3 — fallback (API order)    (everything else)
 */
function sortByTextRelevance(
  items: MarketplaceSearchItem[],
  query: string,
): MarketplaceSearchItem[] {
  const q = query.toLowerCase().trim();
  if (!q) return items;

  const score = (appName: string): number => {
    const n = appName.toLowerCase();
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    if (n.includes(q)) return 2;
    return 3;
  };

  return [...items].sort((a, b) => score(a.appName) - score(b.appName));
}

/** Safely parse the HAL+JSON `_embedded.addons` list. */
function parseAddons(payload: unknown): MarketplaceSearchItem[] {
  const addons = (payload as { _embedded?: { addons?: unknown[] } })
    ?._embedded?.addons;

  if (!Array.isArray(addons)) return [];

  return addons.flatMap((raw) => {
    const addon = raw as {
      key?: string;
      name?: string;
      _embedded?: { vendor?: { name?: string } };
      _links?: { logo?: { href?: string } };
    };

    // Skip malformed entries
    if (!addon.key || !addon.name) return [];

    const vendorName = addon._embedded?.vendor?.name ?? "Unknown";

    // The Marketplace API returns a JSON metadata path at `_links.logo.href`
    // (e.g. "/rest/2/assets/f07b67c7-…") — NOT a direct image URL.
    // Extract the asset ID and build the product-listing CDN URL instead.
    const logoAssetPath = addon._links?.logo?.href;
    const assetId = logoAssetPath?.split("/").pop();
    const logoUrl = assetId
      ? `https://marketplace.atlassian.com/product-listing/files/${assetId}?width=72&height=72`
      : undefined;

    // Resolve status URL server-side — skip if vendor is explicitly blacklisted
    const normalizedVendor = normalizeVendorName(vendorName);
    const statusConfig = VENDOR_BLACKLIST.has(normalizedVendor)
      ? null
      : resolveStatusUrl(addon.name, normalizedVendor);

    return [
      {
        id: addon.key,
        appName: addon.name,
        vendorName,
        logoUrl,
        statusUrl: statusConfig?.statusUrl ?? "",
        checkType: statusConfig?.checkType ?? "custom",
      } satisfies MarketplaceSearchItem,
    ];
  });
}

/**
 * For search results that have no static status URL, attempt auto-discovery
 * by probing common status-page URL patterns (status.vendor.com, vendor.statuspage.io, …).
 *
 * Deduplicates by vendor name so 3 SmartBear apps only fire one probe set, not three.
 * Caps at 12 unique vendors to bound network load; runs all probes in parallel.
 * discoverStatusUrl already has 2 s timeouts per probe, so total added latency ≤ ~2 s.
 */
async function enrichWithDiscovery(
  items: MarketplaceSearchItem[],
): Promise<MarketplaceSearchItem[]> {
  // Exclude blacklisted vendors — their statusUrl is intentionally "" and must stay that way.
  // Without this check, blacklisted vendors fall into auto-discovery and get assigned
  // a random matching URL (e.g. "open source consulting" → slug "open" → status.open.com).
  const uncovered = items.filter((i) => {
    if (i.statusUrl !== "") return false;
    return !VENDOR_BLACKLIST.has(normalizeVendorName(i.vendorName));
  });
  if (uncovered.length === 0) return items;

  // One discovery call per unique normalized vendor name
  const vendorToItems = new Map<string, MarketplaceSearchItem[]>();
  for (const item of uncovered) {
    const vendor = normalizeVendorName(item.vendorName);
    if (!vendorToItems.has(vendor)) vendorToItems.set(vendor, []);
    vendorToItems.get(vendor)!.push(item);
  }

  const uniqueVendors = [...vendorToItems.keys()].slice(0, 12);
  const results = await Promise.allSettled(
    uniqueVendors.map((v) => discoverStatusUrl(v)),
  );

  const discoveryMap = new Map<string, { statusUrl: string; checkType: MarketplaceSearchItem["checkType"] }>();
  uniqueVendors.forEach((vendor, i) => {
    const r = results[i];
    if (r.status === "fulfilled" && r.value) {
      discoveryMap.set(vendor, r.value);
    }
  });

  if (discoveryMap.size === 0) return items;

  return items.map((item) => {
    if (item.statusUrl !== "") return item;
    const discovered = discoveryMap.get(normalizeVendorName(item.vendorName));
    return discovered ? { ...item, ...discovered } : item;
  });
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  // Accept both `query` (our internal name) and `q` for backwards compat
  const text = (searchParams.get("query") ?? searchParams.get("q") ?? "").trim();
  const limit = Math.min(Number(searchParams.get("limit") ?? "50"), 50);

  if (text.length < 2) {
    return NextResponse.json({ items: [] });
  }

  // Cache hit — skip Atlassian round-trip entirely
  const cacheKey = `${text}:${limit}`;
  const cached = getCachedSearch(cacheKey);
  if (cached) {
    return NextResponse.json({ items: cached, cached: true });
  }

  const upstream = new URL(`${MARKETPLACE_BASE}/rest/2/addons`);
  upstream.searchParams.set("text", text);
  upstream.searchParams.set("limit", String(limit));

  try {
    const res = await fetch(upstream.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "NextJS-Marketplace-Proxy/1.0",
      },
      cache: "no-store",
    });

    if (!res.ok) {
      console.error(`[marketplace/search] Atlassian API error: ${res.status} ${res.statusText}`);
      return NextResponse.json(
        { items: [], error: `Marketplace API returned HTTP ${res.status}` },
        { status: res.status },
      );
    }

    const payload = (await res.json()) as unknown;
    const rawItems = sortByTextRelevance(parseAddons(payload), text);

    // Race discovery against a 1.5 s budget. Static-map apps are already fully
    // enriched; discovery only adds bonus coverage for unknown vendors.
    // Clear the fallback timer if discovery wins to avoid timer accumulation.
    let fallbackTimer!: ReturnType<typeof setTimeout>;
    const fallback = new Promise<MarketplaceSearchItem[]>((resolve) => {
      fallbackTimer = setTimeout(() => resolve(rawItems), 1500);
    });
    const items = await Promise.race([
      enrichWithDiscovery(rawItems).finally(() => clearTimeout(fallbackTimer)),
      fallback,
    ]);

    setCachedSearch(cacheKey, items);
    return NextResponse.json({ items });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown upstream error";
    console.error("[marketplace/search] fetch failed:", message);
    return NextResponse.json({ items: [], error: message }, { status: 500 });
  }
}
