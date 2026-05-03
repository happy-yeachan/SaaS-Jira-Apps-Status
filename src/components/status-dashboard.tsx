"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ChevronsUpDown,
  CircleDashed,
  Download,
  ExternalLink,
  LayoutGrid,
  Loader2,
  PlusCircle,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { AddAppDialog } from "@/components/add-app-dialog";
import { AppLogo } from "@/components/app-logo";
import { QuickSetupDialog } from "@/components/quick-setup-dialog";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { resolveStatusUrl, VENDOR_BLACKLIST } from "@/types";
import { normalizeVendorName } from "@/lib/status-discovery";
import type {
  AppHealthStatus,
  HealthCheckResponse,
  HealthCheckResult,
  PingRecord,
  RegisteredApp,
} from "@/types";

const APPS_KEY = "jira-marketplace-apps";
const HISTORY_KEY = "jira-marketplace-history";
const HISTORY_MAX = 30;
const AUTO_REFRESH_MS = 5 * 60 * 1000;
const BAR_COUNT = 30;

interface StatusToast {
  id: string;
  appName: string;
  from: AppHealthStatus;
  to: AppHealthStatus;
}

const STATUS_PRIORITY: Record<AppHealthStatus, number> = {
  outage: 0,
  degraded: 1,
  operational: 2,
};

type SortKey = "appName" | "vendorName" | "status" | "responseTimeMs" | "checkedAt";
type SortDir = "asc" | "desc";

/**
 * Derive the public status page URL from the status API endpoint.
 * Handles both Atlassian Statuspage (/api/v2/status.json or /api/v2/summary.json)
 * and Instatus (/summary.json) formats.
 */
function toStatusPageUrl(statusUrl: string): string | null {
  if (!statusUrl) return null;
  const base = statusUrl.replace(/\/api\/v2\/(status|summary)\.json$|\/summary\.json$|\/index\.json$/g, "");
  return base || null;
}

function uptimePct(history: PingRecord[]): number | null {
  if (history.length === 0) return null;
  const ok = history.filter((r) => r.status === "operational").length;
  return Math.round((ok / history.length) * 100);
}

// ── Heartbeat bars ─────────────────────────────────────────────────────────────
// Uses native `title` tooltip to avoid nested-interactive-element issues.

const HeartbeatBars = memo(function HeartbeatBars({ history }: { history: PingRecord[] }) {
  const slots = useMemo(() => {
    const filled = history.slice(-BAR_COUNT);
    const emptyCount = BAR_COUNT - filled.length;
    return [
      ...Array.from<null>({ length: emptyCount }).fill(null),
      ...filled,
    ] as (PingRecord | null)[];
  }, [history]);

  return (
    <div className="flex items-center gap-px">
      {slots.map((record, idx) => {
        const tip = record
          ? [
              record.status.toUpperCase(),
              new Date(record.timestamp).toLocaleString(),
              record.responseTimeMs != null ? `${record.responseTimeMs} ms` : null,
              record.message ?? null,
            ]
              .filter(Boolean)
              .join("\n")
          : "No data";

        return (
          <span
            key={idx}
            title={tip}
            className={cn(
              "block h-7 w-1 rounded-[2px] cursor-default transition-opacity hover:opacity-60",
              record === null
                ? "bg-slate-200"
                : record.status === "operational"
                  ? "bg-emerald-500"
                  : record.status === "degraded"
                    ? "bg-amber-400"
                    : "bg-red-500",
            )}
          />
        );
      })}
    </div>
  );
});

// ── Status indicator cell ──────────────────────────────────────────────────────

function StatusCell({
  result,
  isUnconfigured,
  isAdding,
}: {
  result: HealthCheckResult | undefined;
  isUnconfigured?: boolean;
  isAdding?: boolean;
}) {
  if (isUnconfigured) {
    return (
      <div className="flex items-center gap-1.5 text-muted-foreground/50">
        <CircleDashed className="h-4 w-4" />
        <span className="text-xs">No status page</span>
      </div>
    );
  }
  if (isAdding && !result) {
    return (
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        <span className="text-xs">Checking…</span>
      </div>
    );
  }
  if (!result) {
    return (
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <CircleDashed className="h-4 w-4" />
        <span className="text-xs">Pending</span>
      </div>
    );
  }

  const { status, message } = result;
  const isError = status !== "operational" && Boolean(message?.trim());

  const indicator = {
    operational: (
      <div className="flex items-center gap-2 text-emerald-600">
        <CheckCircle2 className="h-4 w-4" />
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
        </span>
      </div>
    ),
    degraded: (
      <div className="flex items-center gap-2 text-amber-600">
        <CircleDashed className="h-4 w-4" />
        <span className="h-2 w-2 rounded-full bg-amber-400" />
      </div>
    ),
    outage: (
      <div className="flex items-center gap-2 text-red-600">
        <AlertTriangle className="h-4 w-4" />
        <span className="h-2 w-2 rounded-full bg-red-500" />
      </div>
    ),
  }[status];

  const label = { operational: "Operational", degraded: "Degraded", outage: "Outage" }[status];

  return (
    <div className="flex items-center gap-2">
      {indicator}
      {isError ? (
        <Tooltip>
          <TooltipTrigger className="cursor-help p-0 leading-none">
            <span
              className={cn(
                "inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium",
                status === "outage"
                  ? "bg-red-100 text-red-700"
                  : "bg-amber-100 text-amber-700",
              )}
            >
              {label} ⓘ
            </span>
          </TooltipTrigger>
          <TooltipContent side="right" className="max-w-xs text-xs">
            {message}
          </TooltipContent>
        </Tooltip>
      ) : (
        <span
          className={cn(
            "text-xs font-medium",
            status === "operational" && "text-emerald-700",
            status === "degraded" && "text-amber-700",
            status === "outage" && "text-red-700",
          )}
        >
          {label}
        </span>
      )}
    </div>
  );
}

// ── Sortable column header ─────────────────────────────────────────────────────

function SortableHead({
  label,
  sortKey,
  active,
  dir,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  active: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const isActive = active === sortKey;
  return (
    <TableHead
      className={cn("cursor-pointer select-none group whitespace-nowrap", className)}
      onClick={() => onSort(sortKey)}
    >
      <div className="flex items-center gap-1">
        <span>{label}</span>
        {isActive ? (
          dir === "asc" ? (
            <ChevronUp className="h-3.5 w-3.5" />
          ) : (
            <ChevronDown className="h-3.5 w-3.5" />
          )
        ) : (
          <ChevronsUpDown className="h-3.5 w-3.5 opacity-25 group-hover:opacity-60 transition-opacity" />
        )}
      </div>
    </TableHead>
  );
}

// ── App table row ──────────────────────────────────────────────────────────────

const AppRow = memo(function AppRow({
  app,
  result,
  history,
  onDelete,
  dimmed = false,
  isAdding = false,
}: {
  app: RegisteredApp;
  result: HealthCheckResult | undefined;
  history: PingRecord[];
  onDelete: (app: RegisteredApp) => void;
  dimmed?: boolean;
  isAdding?: boolean;
}) {
  const pct = uptimePct(history);
  const statusPageUrl = toStatusPageUrl(app.statusUrl);
  return (
    <TableRow className={cn("group/row", dimmed && "opacity-50")}>
      {/* App — truncates to fill remaining space */}
      <TableCell className="min-w-0">
        <div className="flex min-w-0 items-center gap-2.5">
          <AppLogo src={app.logoUrl} alt={app.appName} className="h-8 w-8 shrink-0" />
          {statusPageUrl ? (
            <a
              href={statusPageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="group/link flex min-w-0 items-center gap-1 text-sm font-medium leading-tight transition-colors hover:text-blue-600"
            >
              <span className="truncate">{app.appName}</span>
              <ExternalLink className="h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover/link:opacity-100" />
            </a>
          ) : (
            <span className="truncate text-sm font-medium leading-tight">{app.appName}</span>
          )}
        </div>
      </TableCell>
      {/* Vendor — visible from md */}
      <TableCell className="hidden md:table-cell">
        <span className="block truncate text-sm text-muted-foreground">{app.vendorName}</span>
      </TableCell>
      {/* Status */}
      <TableCell>
        <StatusCell result={result} isUnconfigured={!app.statusUrl} isAdding={isAdding} />
      </TableCell>
      {/* History — visible from lg */}
      <TableCell className="hidden lg:table-cell">
        <div className="flex items-center gap-3">
          <HeartbeatBars history={history} />
          {pct !== null && (
            <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
              {pct}%
            </span>
          )}
        </div>
      </TableCell>
      {/* Response — visible from lg */}
      <TableCell className="hidden lg:table-cell tabular-nums text-sm text-muted-foreground">
        {result?.responseTimeMs != null ? `${result.responseTimeMs} ms` : "—"}
      </TableCell>
      {/* Checked — visible from xl */}
      <TableCell className="hidden xl:table-cell text-xs text-muted-foreground">
        {result?.checkedAt ? new Date(result.checkedAt).toLocaleTimeString() : "—"}
      </TableCell>
      {/* Delete — always visible, faint until hover */}
      <TableCell className="w-12 text-right">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 opacity-40 transition-opacity group-hover/row:opacity-100"
          onClick={() => onDelete(app)}
          aria-label={`Remove ${app.appName}`}
        >
          <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </TableCell>
    </TableRow>
  );
});

// ── Main dashboard ─────────────────────────────────────────────────────────────

export function StatusDashboard() {
  // ── State ──────────────────────────────────────────────────────────────────
  // `isMounted` is false on the server and on the very first client render.
  // All localStorage-derived values are hidden until it becomes true, so the
  // SSR HTML and the initial client render are identical — no hydration mismatch.
  const [isMounted, setIsMounted] = useState(false);

  // Lazy initializers still correctly pre-populate state from localStorage on
  // the client; we just don't *render* that data until after hydration.
  const [apps, setApps] = useState<RegisteredApp[]>(() => {
    if (typeof window === "undefined") return [];
    try {
      const raw = localStorage.getItem(APPS_KEY);
      if (raw !== null) {
        const parsed = JSON.parse(raw) as RegisteredApp[];
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      localStorage.removeItem(APPS_KEY);
    }
    return [];
  });

  const [historyById, setHistoryById] = useState<Record<string, PingRecord[]>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const raw = localStorage.getItem(HISTORY_KEY);
      if (raw) return JSON.parse(raw) as Record<string, PingRecord[]>;
    } catch {
      localStorage.removeItem(HISTORY_KEY);
    }
    return {};
  });
  const [latestById, setLatestById] = useState<Record<string, HealthCheckResult>>({});
  const [addingIds, setAddingIds] = useState<Set<string>>(new Set());
  const [isChecking, setIsChecking] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("status");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [quickSetupOpen, setQuickSetupOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<RegisteredApp | null>(null);
  const [toasts, setToasts] = useState<StatusToast[]>([]);
  const [lastCheckedAt, setLastCheckedAt] = useState<Date | null>(null);

  // Use a ref so async callbacks always read the latest apps value
  const appsRef = useRef(apps);
  useEffect(() => {
    appsRef.current = apps;
  }, [apps]);

  // ── Persist ────────────────────────────────────────────────────────────────
  // No hydration effect needed — lazy initializers above handle the first load.

  useEffect(() => {
    localStorage.setItem(APPS_KEY, JSON.stringify(apps));
  }, [apps]);

  useEffect(() => {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(historyById));
  }, [historyById]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    (appName: string, from: AppHealthStatus, to: AppHealthStatus) => {
      const id = Math.random().toString(36).slice(2, 9);
      setToasts((prev) => [...prev.slice(-4), { id, appName, from, to }]);
      setTimeout(() => dismissToast(id), 6000);
    },
    [dismissToast],
  );

  // ── Health checks ──────────────────────────────────────────────────────────
  const applyResults = useCallback((results: HealthCheckResult[], prevById: Record<string, HealthCheckResult>) => {
    // Detect status degradations → show toast
    for (const r of results) {
      const prev = prevById[r.appId];
      if (prev && prev.status !== r.status) {
        const appName = appsRef.current.find((a) => a.id === r.appId)?.appName ?? r.appId;
        addToast(appName, prev.status, r.status);
      }
    }

    // Self-healing: persist any auto-discovered URL replacements to localStorage
    const healed = results.filter((r) => r.updatedStatusUrl);
    if (healed.length > 0) {
      setApps((prev) =>
        prev.map((app) => {
          const fix = healed.find((r) => r.appId === app.id);
          if (!fix?.updatedStatusUrl) return app;
          return {
            ...app,
            statusUrl: fix.updatedStatusUrl,
            checkType: fix.updatedCheckType ?? app.checkType,
          };
        }),
      );
    }

    setLatestById((prev) => ({
      ...prev,
      ...Object.fromEntries(results.map((r) => [r.appId, r])),
    }));
    setHistoryById((prev) => {
      const next = { ...prev };
      for (const r of results) {
        const record: PingRecord = {
          status: r.status,
          timestamp: r.checkedAt,
          responseTimeMs: r.responseTimeMs,
          message: r.message,
        };
        next[r.appId] = [...(next[r.appId] ?? []), record].slice(-HISTORY_MAX);
      }
      return next;
    });
  }, [addToast]);

  const latestByIdRef = useRef<Record<string, HealthCheckResult>>({});
  useEffect(() => { latestByIdRef.current = latestById; }, [latestById]);

  const checkAllStatuses = async () => {
    const appsList = appsRef.current;
    const checkableApps = appsList.filter((a) => a.statusUrl);
    if (checkableApps.length === 0) return;
    setIsChecking(true);
    try {
      const res = await fetch("/api/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apps: checkableApps }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as HealthCheckResponse;
      applyResults(data.results, latestByIdRef.current);
      setLastCheckedAt(new Date());
    } catch {
      setLatestById((prev) => {
        const next = { ...prev };
        for (const app of checkableApps) {
          if (!next[app.id]) {
            next[app.id] = {
              appId: app.id,
              status: "outage",
              checkedAt: new Date().toISOString(),
              responseTimeMs: null,
              message: "Health check request failed",
            };
          }
        }
        return next;
      });
    } finally {
      setIsChecking(false);
    }
  };

  // ── URL migration ───────────────────────────────────────────────────────────
  // Re-resolve statusUrl + checkType for every stored app against the current
  // PRODUCT_RULES / VENDOR_STATUS_MAP. This silently fixes stale localStorage
  // data (e.g. old draw.io summary.json URL) without requiring a manual reset.
  useEffect(() => {
    setApps((prev) => {
      let changed = false;
      const migrated = prev.map((app) => {
        const normalizedVendor = normalizeVendorName(app.vendorName);

        // Blacklisted vendors must have no status URL. If a previous bug assigned
        // one (e.g. PRODUCT_RULES "structure" keyword matching an OSCI app), clear it.
        if (VENDOR_BLACKLIST.has(normalizedVendor)) {
          if (app.statusUrl !== "" || app.checkType !== "custom") {
            changed = true;
            return { ...app, statusUrl: "", checkType: "custom" as const };
          }
          return app;
        }

        const resolved = resolveStatusUrl(app.appName, normalizedVendor);
        if (
          resolved &&
          (resolved.statusUrl !== app.statusUrl || resolved.checkType !== app.checkType)
        ) {
          changed = true;
          return { ...app, statusUrl: resolved.statusUrl, checkType: resolved.checkType };
        }
        return app;
      });
      return changed ? migrated : prev;
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Multi-tab sync — re-read localStorage when another tab writes to our keys.
  // The `storage` event only fires in OTHER tabs/windows, not the current one,
  // so there is no risk of an update loop with the persist effects above.
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === APPS_KEY && e.newValue !== null) {
        try {
          const parsed = JSON.parse(e.newValue) as RegisteredApp[];
          if (Array.isArray(parsed)) setApps(parsed);
        } catch { /* ignore corrupt data */ }
      }
      if (e.key === HISTORY_KEY && e.newValue !== null) {
        try {
          const parsed = JSON.parse(e.newValue) as Record<string, PingRecord[]>;
          setHistoryById(parsed);
        } catch { /* ignore corrupt data */ }
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  // Mark as mounted — flips the isMounted guard so client-specific data renders.
  useEffect(() => { setIsMounted(true); }, []);

  // Initial health check fires after mount so the real table is visible first.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (isMounted) void checkAllStatuses(); }, [isMounted]);

  // Auto-refresh every 5 minutes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!isMounted) return;
    const id = setInterval(() => void checkAllStatuses(), AUTO_REFRESH_MS);
    return () => clearInterval(id);
  }, [isMounted]);

  // ── Sort ───────────────────────────────────────────────────────────────────
  const handleSort = (key: SortKey) => {
    setSortDir((prev) => (sortKey === key ? (prev === "asc" ? "desc" : "asc") : "asc"));
    setSortKey(key);
  };

  // ── App CRUD ───────────────────────────────────────────────────────────────
  const handleAddApp = (app: RegisteredApp) => {
    setApps((prev) => [app, ...prev]);
    if (!app.statusUrl) return;
    setAddingIds((prev) => new Set([...prev, app.id]));
    void fetch("/api/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apps: [app] }),
    })
      .then((r) => (r.ok ? (r.json() as Promise<HealthCheckResponse>) : null))
      .then((data) => {
        if (data?.results?.[0]) applyResults(data.results, latestByIdRef.current);
      })
      .catch(() => undefined)
      .finally(() => {
        setAddingIds((prev) => { const n = new Set(prev); n.delete(app.id); return n; });
      });
  };

  const handleBulkAddApps = (newApps: RegisteredApp[]) => {
    if (newApps.length === 0) return;
    setApps((prev) => {
      const incomingById = new Map(newApps.map((a) => [a.id, a]));
      const next = prev.map((a) => {
        const upd = incomingById.get(a.id);
        return upd ? { ...a, ...upd } : a;
      });
      const prevIds = new Set(prev.map((a) => a.id));
      const brandNew = newApps.filter((a) => !prevIds.has(a.id));
      return brandNew.length > 0 || next.some((a, i) => a !== prev[i])
        ? [...brandNew, ...next]
        : prev;
    });
    const checkableApps = newApps.filter((a) => a.statusUrl);
    if (checkableApps.length > 0) {
      const ids = checkableApps.map((a) => a.id);
      setAddingIds((prev) => new Set([...prev, ...ids]));
      void fetch("/api/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apps: checkableApps }),
      })
        .then((r) => (r.ok ? (r.json() as Promise<HealthCheckResponse>) : null))
        .then((data) => { if (data?.results) applyResults(data.results, latestByIdRef.current); })
        .catch(() => undefined)
        .finally(() => {
          setAddingIds((prev) => { const n = new Set(prev); ids.forEach((id) => n.delete(id)); return n; });
        });
    }
  };

  const handleDeleteApp = useCallback((appId: string) => {
    setApps((prev) => prev.filter((a) => a.id !== appId));
    setLatestById((prev) => { const n = { ...prev }; delete n[appId]; return n; });
    setHistoryById((prev) => { const n = { ...prev }; delete n[appId]; return n; });
  }, []);

  const handleRequestDelete = useCallback((app: RegisteredApp) => {
    setDeleteTarget(app);
  }, []);

  const handleExport = useCallback(() => {
    const blob = new Blob(
      [JSON.stringify({ exportedAt: new Date().toISOString(), apps }, null, 2)],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `jira-apps-status-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [apps]);

  // ── Derived ────────────────────────────────────────────────────────────────
  const existingIds = useMemo(() => new Set(apps.map((a) => a.id)), [apps]);

  const summary = useMemo(() => {
    const vals = Object.values(latestById);
    return {
      operational: vals.filter((r) => r.status === "operational").length,
      degraded: vals.filter((r) => r.status === "degraded").length,
      outage: vals.filter((r) => r.status === "outage").length,
    };
  }, [latestById]);

  const [unconfiguredOpen, setUnconfiguredOpen] = useState(false);

  const { monitoredApps, unconfiguredApps } = useMemo(() => {
    const sorted = [...apps].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "appName":
          cmp = a.appName.localeCompare(b.appName);
          break;
        case "vendorName":
          cmp = a.vendorName.localeCompare(b.vendorName);
          break;
        case "status": {
          const aPri = STATUS_PRIORITY[latestById[a.id]?.status ?? "degraded"] ?? 3;
          const bPri = STATUS_PRIORITY[latestById[b.id]?.status ?? "degraded"] ?? 3;
          cmp = aPri - bPri;
          break;
        }
        case "responseTimeMs": {
          const aMs = latestById[a.id]?.responseTimeMs ?? Infinity;
          const bMs = latestById[b.id]?.responseTimeMs ?? Infinity;
          cmp = aMs - bMs;
          break;
        }
        case "checkedAt": {
          const aT = latestById[a.id]?.checkedAt
            ? new Date(latestById[a.id]!.checkedAt).getTime()
            : 0;
          const bT = latestById[b.id]?.checkedAt
            ? new Date(latestById[b.id]!.checkedAt).getTime()
            : 0;
          cmp = aT - bT;
          break;
        }
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return {
      monitoredApps: sorted.filter((a) => a.statusUrl),
      unconfiguredApps: sorted.filter((a) => !a.statusUrl),
    };
  }, [apps, latestById, sortKey, sortDir]);

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <main className="mx-auto w-full max-w-7xl px-6 py-8">
      {/* Toast container */}
      <div className="fixed right-4 top-4 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            className="pointer-events-auto flex items-center gap-2.5 rounded-lg border bg-card px-3 py-2.5 shadow-lg text-sm"
          >
            {toast.to === "operational" ? (
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" />
            ) : toast.to === "degraded" ? (
              <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
            ) : (
              <AlertTriangle className="h-4 w-4 shrink-0 text-red-500" />
            )}
            <div className="min-w-0">
              <span className="font-medium">{toast.appName}</span>
              <span className="ml-1.5 text-muted-foreground capitalize">
                {toast.from} → {toast.to}
              </span>
            </div>
            <button
              onClick={() => dismissToast(toast.id)}
              className="ml-1 shrink-0 text-muted-foreground hover:text-foreground"
              aria-label="Dismiss"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>

      {/* Header */}
      <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">
            Atlassian Marketplace Status
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Real-time service health for Jira &amp; Confluence third-party apps.
            {lastCheckedAt && (
              <span className="ml-2 text-xs">
                · Last checked {lastCheckedAt.toLocaleTimeString()}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void checkAllStatuses()}
            disabled={isChecking}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isChecking && "animate-spin")} />
            Refresh
          </Button>
          {isMounted && apps.length > 0 && (
            <Tooltip>
              {/* render=<span> avoids <button> inside <button> — base-ui Trigger defaults to <button> */}
              <TooltipTrigger render={<span className="inline-flex" />}>
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={handleExport}>
                  <Download className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Export app list</TooltipContent>
            </Tooltip>
          )}
          <div className="h-4 w-px bg-border" />
          <Button
            variant="outline"
            size="sm"
            onClick={() => setQuickSetupOpen(true)}
          >
            <Sparkles className="h-3.5 w-3.5" />
            Quick Setup
          </Button>
          <Button size="sm" onClick={() => setAddDialogOpen(true)}>
            <PlusCircle className="h-3.5 w-3.5" />
            Add App
          </Button>
          <div className="h-4 w-px bg-border" />
          <ThemeToggle />
        </div>
      </div>

      {/*
        isMounted guard — everything below reads from localStorage-backed state.
        Rendering it before mount would produce a different output than the SSR
        HTML, causing a hydration mismatch.
        The skeleton is pure static markup that matches the server render exactly.
      */}
      {!isMounted ? (
        /* Loading skeleton — shown on server and on the very first client paint */
        <div className="animate-pulse space-y-3">
          {/* Badge row skeleton */}
          <div className="flex flex-wrap gap-2">
            {[96, 80, 72, 88].map((w) => (
              <div key={w} className={`h-6 rounded-full bg-muted`} style={{ width: w }} />
            ))}
          </div>
          {/* Table skeleton */}
          <div className="rounded-lg border">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                key={i}
                className="flex items-center gap-4 border-b px-4 py-3 last:border-0"
              >
                <div className="h-8 w-8 shrink-0 rounded-lg bg-muted" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 w-44 rounded bg-muted" />
                  <div className="h-2.5 w-28 rounded bg-muted" />
                </div>
                <div className="h-4 w-24 rounded bg-muted" />
                <div className="h-7 w-[122px] rounded bg-muted" />
                <div className="h-3 w-14 rounded bg-muted" />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <>
          {/* Summary bar */}
          <div className="mb-4 flex flex-wrap items-center gap-2">
            <Badge className="gap-1.5 bg-emerald-100 text-emerald-800 hover:bg-emerald-100 dark:bg-emerald-900/30 dark:text-emerald-400 dark:hover:bg-emerald-900/30">
              <CheckCircle2 className="h-3 w-3" />
              Operational
              <span className="ml-0.5 font-bold">{summary.operational}</span>
            </Badge>
            <Badge className="gap-1.5 bg-amber-100 text-amber-800 hover:bg-amber-100 dark:bg-amber-900/30 dark:text-amber-400 dark:hover:bg-amber-900/30">
              <CircleDashed className="h-3 w-3" />
              Degraded
              <span className="ml-0.5 font-bold">{summary.degraded}</span>
            </Badge>
            <Badge className="gap-1.5 bg-red-100 text-red-800 hover:bg-red-100 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/30">
              <AlertTriangle className="h-3 w-3" />
              Outage
              <span className="ml-0.5 font-bold">{summary.outage}</span>
            </Badge>
            <Badge variant="outline" className="text-muted-foreground">
              {apps.length} monitored
            </Badge>
          </div>

          {/* Table or empty state */}
          {apps.length === 0 ? (
            <div className="flex flex-col items-center justify-center rounded-lg border border-dashed bg-muted/30 py-20 text-center">
              <LayoutGrid className="mb-4 h-12 w-12 text-muted-foreground/40" />
              <h3 className="text-base font-semibold">No apps monitored</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Pick the apps your team uses from a curated list, or search the Marketplace.
              </p>
              <div className="mt-6 flex gap-3">
                <Button onClick={() => setQuickSetupOpen(true)}>
                  <Sparkles className="mr-1.5 h-4 w-4" />
                  Quick Setup
                </Button>
                <Button variant="outline" onClick={() => setAddDialogOpen(true)}>
                  <PlusCircle className="mr-1.5 h-4 w-4" />
                  Add App
                </Button>
              </div>
            </div>
          ) : (
            <div className="rounded-lg border bg-card">
              <Table className="w-full table-fixed">
                <TableHeader>
                  <TableRow>
                    {/* App — takes all remaining space */}
                    <SortableHead
                      label="App"
                      sortKey="appName"
                      active={sortKey}
                      dir={sortDir}
                      onSort={handleSort}
                    />
                    {/* Vendor — md+ */}
                    <SortableHead
                      label="Vendor"
                      sortKey="vendorName"
                      active={sortKey}
                      dir={sortDir}
                      onSort={handleSort}
                      className="hidden md:table-cell w-[18%]"
                    />
                    {/* Status */}
                    <SortableHead
                      label="Status"
                      sortKey="status"
                      active={sortKey}
                      dir={sortDir}
                      onSort={handleSort}
                      className="w-36"
                    />
                    {/* History — lg+ */}
                    <TableHead className="hidden lg:table-cell w-[200px]">
                      History (last {BAR_COUNT})
                    </TableHead>
                    {/* Response — lg+ */}
                    <SortableHead
                      label="Response"
                      sortKey="responseTimeMs"
                      active={sortKey}
                      dir={sortDir}
                      onSort={handleSort}
                      className="hidden lg:table-cell w-24"
                    />
                    {/* Checked — xl+ */}
                    <SortableHead
                      label="Checked"
                      sortKey="checkedAt"
                      active={sortKey}
                      dir={sortDir}
                      onSort={handleSort}
                      className="hidden xl:table-cell w-24"
                    />
                    {/* Delete */}
                    <TableHead className="w-12" />
                  </TableRow>
                </TableHeader>

                <TableBody>
                  {monitoredApps.map((app) => (
                    <AppRow
                      key={app.id}
                      app={app}
                      result={latestById[app.id]}
                      history={historyById[app.id] ?? []}
                      onDelete={handleRequestDelete}
                      isAdding={addingIds.has(app.id)}
                    />
                  ))}

                  {/* Unconfigured apps — collapsed by default */}
                  {unconfiguredApps.length > 0 && (
                    <>
                      <TableRow
                        className="cursor-pointer select-none hover:bg-muted/40 border-t-2"
                        role="button"
                        tabIndex={0}
                        onClick={() => setUnconfiguredOpen((o) => !o)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setUnconfiguredOpen((o) => !o);
                          }
                        }}
                        aria-expanded={unconfiguredOpen}
                      >
                        <TableCell colSpan={7} className="py-2.5">
                          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <ChevronRight
                              className={cn(
                                "h-3.5 w-3.5 transition-transform duration-150",
                                unconfiguredOpen && "rotate-90",
                              )}
                            />
                            <span>No status page</span>
                            <span className="rounded-full bg-muted px-1.5 py-0.5 font-medium tabular-nums">
                              {unconfiguredApps.length}
                            </span>
                          </div>
                        </TableCell>
                      </TableRow>
                      {unconfiguredOpen &&
                        unconfiguredApps.map((app) => (
                          <AppRow
                            key={app.id}
                            app={app}
                            result={latestById[app.id]}
                            history={historyById[app.id] ?? []}
                            onDelete={handleRequestDelete}
                            dimmed
                            isAdding={addingIds.has(app.id)}
                          />
                        ))}
                    </>
                  )}
                </TableBody>
              </Table>
            </div>
          )}

          <AddAppDialog
            open={addDialogOpen}
            onOpenChange={setAddDialogOpen}
            onAddApp={handleAddApp}
            existingIds={existingIds}
          />
          <QuickSetupDialog
            open={quickSetupOpen}
            onOpenChange={setQuickSetupOpen}
            onBulkAddApps={handleBulkAddApps}
            existingIds={existingIds}
          />

          {/* Delete confirmation */}
          <Dialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
            <DialogContent className="sm:max-w-sm">
              <DialogHeader>
                <DialogTitle>Remove app</DialogTitle>
                <DialogDescription>
                  Remove <span className="font-medium text-foreground">{deleteTarget?.appName}</span> from your dashboard? This also clears its history.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" size="sm" onClick={() => setDeleteTarget(null)}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => {
                    if (deleteTarget) {
                      handleDeleteApp(deleteTarget.id);
                      setDeleteTarget(null);
                    }
                  }}
                >
                  Remove
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </main>
  );
}
