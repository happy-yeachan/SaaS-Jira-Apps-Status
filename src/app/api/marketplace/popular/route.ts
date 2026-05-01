import { NextResponse } from "next/server";
import { resolveStatusUrl, VENDOR_BLACKLIST, type MarketplaceSearchItem } from "@/types";
import { normalizeVendorName } from "@/lib/status-discovery";

export type PopularApp = MarketplaceSearchItem & { category: string };

interface CuratedEntry {
  query: string;
  vendorHint: string;
  category: string;
}

const CURATED: CuratedEntry[] = [
  // Automation
  { query: "ScriptRunner for Jira", vendorHint: "adaptavist", category: "Automation" },
  // Time Tracking
  { query: "Tempo Timesheets", vendorHint: "tempo", category: "Time Tracking" },
  { query: "Tempo Planner", vendorHint: "tempo", category: "Time Tracking" },
  // Testing & QA
  { query: "Zephyr Scale Test Management", vendorHint: "smartbear", category: "Testing & QA" },
  { query: "Xray Test Management for Jira", vendorHint: "tricentis", category: "Testing & QA" },
  // Diagrams
  { query: "draw.io Diagrams for Jira", vendorHint: "seibert", category: "Diagrams" },
  { query: "Gliffy Diagrams for Jira", vendorHint: "gliffy", category: "Diagrams" },
  { query: "Lucidchart Diagrams Connector", vendorHint: "lucid", category: "Diagrams" },
  { query: "Miro for Jira", vendorHint: "miro", category: "Diagrams" },
  // Reporting
  { query: "EazyBI for Jira", vendorHint: "eazybi", category: "Reporting" },
  { query: "Custom Charts for Jira", vendorHint: "tempo", category: "Reporting" },
  // Planning
  { query: "BigPicture Portfolio", vendorHint: "appfire", category: "Planning" },
  { query: "Structure for Jira", vendorHint: "tempo", category: "Planning" },
  { query: "Easy Agile Roadmaps for Jira", vendorHint: "easy agile", category: "Planning" },
  // Dev Tools
  { query: "Git Integration for Jira", vendorHint: "gitkraken", category: "Dev Tools" },
  { query: "Exalate Issue Sync", vendorHint: "exalate", category: "Dev Tools" },
  // Integrations
  { query: "Elements Connect", vendorHint: "valiantys", category: "Integrations" },
  // Utilities
  { query: "OKR Board for Jira", vendorHint: "oboard", category: "Utilities" },
  { query: "Balsamiq Wireframes for Jira", vendorHint: "balsamiq", category: "Utilities" },
  { query: "Jira Misc Workflow Extensions", vendorHint: "innovalog", category: "Utilities" },
  { query: "Power Scripts for Jira", vendorHint: "appfire", category: "Utilities" },
];

const MARKETPLACE_BASE = "https://marketplace.atlassian.com";

interface RawAddon {
  key?: string;
  name?: string;
  _embedded?: { vendor?: { name?: string } };
  _links?: { logo?: { href?: string } };
}

async function fetchBestMatch(entry: CuratedEntry): Promise<PopularApp | null> {
  const url = `${MARKETPLACE_BASE}/rest/2/addons?text=${encodeURIComponent(entry.query)}&limit=10`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "NextJS-Marketplace-Proxy/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;

    const payload = (await res.json()) as { _embedded?: { addons?: RawAddon[] } };
    const addons = payload._embedded?.addons ?? [];
    if (addons.length === 0) return null;

    const hint = entry.vendorHint.toLowerCase();
    const queryLower = entry.query.toLowerCase();
    // Key words: skip common stop words so "for Jira" doesn't dilute the match
    const STOP = new Set(["for", "the", "and", "by", "of", "to", "a", "jira", "cloud"]);
    const keyWords = queryLower.split(" ").filter((w) => !STOP.has(w));

    const vendorMatches = (a: RawAddon) =>
      (a._embedded?.vendor?.name ?? "").toLowerCase().includes(hint);
    const nameMatches = (a: RawAddon) => {
      const n = a.name?.toLowerCase() ?? "";
      return keyWords.length > 0 && keyWords.every((w) => n.includes(w));
    };

    const best =
      // Exact name + vendor
      addons.find((a) => a.name?.toLowerCase() === queryLower && vendorMatches(a)) ??
      // All key words in name + vendor
      addons.find((a) => nameMatches(a) && vendorMatches(a)) ??
      // Vendor match alone (first result from this vendor)
      addons.find((a) => vendorMatches(a)) ??
      // Any name key-word match
      addons.find((a) => nameMatches(a)) ??
      addons[0];

    if (!best?.key || !best?.name) return null;

    const vendorName = best._embedded?.vendor?.name ?? "Unknown";
    const assetId = best._links?.logo?.href?.split("/").pop();
    const logoUrl = assetId
      ? `${MARKETPLACE_BASE}/product-listing/files/${assetId}?width=72&height=72`
      : undefined;

    const normalizedVendor = normalizeVendorName(vendorName);
    const statusConfig = VENDOR_BLACKLIST.has(normalizedVendor)
      ? null
      : resolveStatusUrl(best.name, normalizedVendor);

    return {
      id: best.key,
      appName: best.name,
      vendorName,
      logoUrl,
      statusUrl: statusConfig?.statusUrl ?? "",
      checkType: statusConfig?.checkType ?? "custom",
      category: entry.category,
    };
  } catch {
    return null;
  }
}

// In-memory cache — avoids hammering the Marketplace API on every page load.
let cache: PopularApp[] | null = null;
let cacheExpiry = 0;

export async function GET() {
  const now = Date.now();
  if (cache && now < cacheExpiry) {
    return NextResponse.json({ apps: cache });
  }

  const results = await Promise.all(CURATED.map(fetchBestMatch));
  const seen = new Set<string>();
  const apps = results.filter((a): a is PopularApp => {
    if (!a || seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });

  cache = apps;
  cacheExpiry = now + 60 * 60 * 1000;

  return NextResponse.json({ apps });
}
