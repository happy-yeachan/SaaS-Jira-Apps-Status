/**
 * Legacy route — forwards to /api/marketplace/search to preserve backwards
 * compatibility with any callers still using /api/marketplace?q=...
 */
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);

  const query =
    searchParams.get("query") ??
    searchParams.get("q") ??
    searchParams.get("text") ??
    "";
  const limit = searchParams.get("limit") ?? "10";

  const target = new URL(`${origin}/api/marketplace/search`);
  target.searchParams.set("query", query);
  target.searchParams.set("limit", limit);

  const res = await fetch(target.toString(), { cache: "no-store" });
  const data = (await res.json()) as unknown;
  return NextResponse.json(data, { status: res.status });
}
