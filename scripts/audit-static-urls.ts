/**
 * Static URL liveness audit.
 *
 * Imports PRODUCT_RULES + VENDOR_STATUS_MAP directly from src/types/index.ts
 * (no hand-mirrored copy — runs against the actual production source) and
 * probes every unique URL with up to 3 attempts each. Exits 1 if any URL
 * is dead so CI can block PRs that introduce broken vendor mappings.
 *
 * Run locally:   npm run audit:urls
 * Run in CI:     .github/workflows/url-liveness.yml fires this weekly + on PR
 *                if pipeline files change.
 *
 * Why TypeScript + --experimental-strip-types instead of a hand-mirrored .mjs?
 *   The audit script imports the same VENDOR_STATUS_MAP / PRODUCT_RULES the
 *   app uses at runtime. There is exactly one source of truth — drift between
 *   the audit and production cannot happen.
 */

import { PRODUCT_RULES, VENDOR_STATUS_MAP } from "../src/types/index.ts";

const TIMEOUT_MS = 8000;
const RETRIES = 3;
const RETRY_DELAY_MS = 1500;

interface Probe {
  url: string;
  origin: string; // human-readable: "VENDOR_STATUS_MAP[appfire]" or "PRODUCT_RULES[zephyr]"
  ok: boolean;
  reason?: string;
  pageName?: string;
  attempts: number;
}

function pageNameFromJson(j: unknown): string | null {
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  const page = o.page as Record<string, unknown> | undefined;
  if (typeof page?.name === "string") return page.name;
  const data = o.data as Record<string, unknown> | undefined;
  const attrs = data?.attributes as Record<string, unknown> | undefined;
  if (typeof attrs?.name === "string") return attrs.name;
  return null;
}

function isStatuspageLike(j: unknown): boolean {
  if (!j || typeof j !== "object") return false;
  const o = j as Record<string, unknown>;
  const status = o.status as Record<string, unknown> | undefined;
  const page = o.page as Record<string, unknown> | undefined;
  return (
    typeof status?.indicator === "string" ||
    typeof page?.status === "string" ||
    (o.data !== undefined && Array.isArray(o.included))
  );
}

async function probeOnce(url: string): Promise<{ ok: boolean; reason?: string; pageName?: string }> {
  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; StatusAudit/1.0)",
      },
    });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) return { ok: false, reason: `non-JSON content-type (${ct || "missing"})` };
    const json = await res.json();
    if (!isStatuspageLike(json)) return { ok: false, reason: "not statuspage-like JSON shape" };
    return { ok: true, pageName: pageNameFromJson(json) ?? undefined };
  } catch (e) {
    const err = e as Error;
    return { ok: false, reason: err.name === "TimeoutError" ? "timeout" : err.message };
  }
}

async function probeWithRetry(url: string): Promise<{ ok: boolean; reason?: string; pageName?: string; attempts: number }> {
  let last: Awaited<ReturnType<typeof probeOnce>> = { ok: false, reason: "no attempts" };
  for (let i = 1; i <= RETRIES; i++) {
    last = await probeOnce(url);
    if (last.ok) return { ...last, attempts: i };
    if (i < RETRIES) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }
  return { ...last, attempts: RETRIES };
}

// ── Collect all unique URLs with origin labels ───────────────────────────────
const urlOrigins = new Map<string, string[]>();
for (const [vendor, url] of Object.entries(VENDOR_STATUS_MAP)) {
  if (!urlOrigins.has(url)) urlOrigins.set(url, []);
  urlOrigins.get(url)!.push(`VENDOR_STATUS_MAP["${vendor}"]`);
}
for (const rule of PRODUCT_RULES) {
  if (!urlOrigins.has(rule.url)) urlOrigins.set(rule.url, []);
  urlOrigins.get(rule.url)!.push(`PRODUCT_RULES[${rule.keywords.join(" + ")}]`);
}

const total = urlOrigins.size;
console.log(`Probing ${total} unique URLs (${RETRIES} attempts each, ${TIMEOUT_MS}ms timeout)`);
console.log("─".repeat(80));

// ── Probe (limited concurrency to avoid overwhelming targets) ────────────────
const CONCURRENCY = 6;
const entries = [...urlOrigins.entries()];
const results: Probe[] = [];

let cursor = 0;
async function worker() {
  while (true) {
    const i = cursor++;
    if (i >= entries.length) return;
    const [url, origins] = entries[i];
    const r = await probeWithRetry(url);
    results.push({
      url,
      origin: origins.join(", "),
      ok: r.ok,
      reason: r.reason,
      pageName: r.pageName,
      attempts: r.attempts,
    });
    const status = r.ok ? "✓" : "✗";
    const detail = r.ok ? `(page: ${r.pageName ?? "—"})` : `(${r.reason}, ${r.attempts} attempts)`;
    console.log(`  ${status}  ${url}  ${detail}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

// ── Summarise ────────────────────────────────────────────────────────────────
const dead = results.filter((r) => !r.ok);
const live = results.filter((r) => r.ok);

console.log("─".repeat(80));
console.log(`Result: ${live.length}/${total} live, ${dead.length} dead`);

if (dead.length > 0) {
  console.log("");
  console.log("Dead URLs:");
  for (const d of dead) {
    console.log(`  ${d.url}`);
    console.log(`    origin: ${d.origin}`);
    console.log(`    reason: ${d.reason}`);
  }
  console.log("");
  console.log("Action: update src/types/index.ts — replace dead URLs with working ones,");
  console.log("        move private/dead vendors to VENDOR_BLACKLIST, or remove the entry.");
  process.exit(1);
}

console.log("All static URLs are live. ✓");
