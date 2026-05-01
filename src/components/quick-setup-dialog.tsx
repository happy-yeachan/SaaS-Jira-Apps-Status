"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2, Sparkles } from "lucide-react";
import { AppLogo } from "@/components/app-logo";
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
import type { PopularApp } from "@/app/api/marketplace/popular/route";
import type { RegisteredApp } from "@/types";

interface QuickSetupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onBulkAddApps: (apps: RegisteredApp[]) => void;
  existingIds?: Set<string>;
}

const CATEGORY_ORDER = [
  "Automation",
  "Time Tracking",
  "Testing & QA",
  "Diagrams",
  "Reporting",
  "Planning",
  "Dev Tools",
  "Integrations",
  "Utilities",
];

function SkeletonRow() {
  return (
    <div className="flex animate-pulse items-center gap-3 rounded-md px-3 py-2">
      <div className="h-4 w-4 shrink-0 rounded bg-muted" />
      <div className="h-8 w-8 shrink-0 rounded-lg bg-muted" />
      <div className="flex-1 space-y-1.5">
        <div className="h-3 w-36 rounded bg-muted" />
        <div className="h-2 w-24 rounded bg-muted" />
      </div>
      <div className="h-4 w-10 rounded bg-muted" />
    </div>
  );
}

function CategorySkeleton({ label }: { label: string }) {
  return (
    <div>
      <div className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <SkeletonRow />
      <SkeletonRow />
    </div>
  );
}

export function QuickSetupDialog({
  open,
  onOpenChange,
  onBulkAddApps,
  existingIds = new Set(),
}: QuickSetupDialogProps) {
  const [apps, setApps] = useState<PopularApp[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const fetchedRef = useRef(false);

  useEffect(() => {
    if (!open || fetchedRef.current) return;
    fetchedRef.current = true;
    setLoading(true);
    setError(false);

    fetch("/api/marketplace/popular")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ apps: PopularApp[] }>;
      })
      .then(({ apps: fetched }) => {
        setApps(fetched);
        // Pre-select apps that have a known status URL and are not already added
        const preSelected = new Set(
          fetched
            .filter((a) => a.statusUrl !== "" && !existingIds.has(a.id))
            .map((a) => a.id),
        );
        setSelected(preSelected);
      })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const addableApps = apps.filter((a) => !existingIds.has(a.id));
  const selectableIds = new Set(addableApps.map((a) => a.id));

  const allSelected =
    selectableIds.size > 0 && [...selectableIds].every((id) => selected.has(id));
  const noneSelected = [...selectableIds].every((id) => !selected.has(id));

  const toggleAll = () => {
    if (allSelected) {
      setSelected((prev) => {
        const next = new Set(prev);
        selectableIds.forEach((id) => next.delete(id));
        return next;
      });
    } else {
      setSelected((prev) => new Set([...prev, ...selectableIds]));
    }
  };

  const toggleOne = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleAdd = () => {
    const toAdd = apps
      .filter((a) => selected.has(a.id) && !existingIds.has(a.id))
      .map(
        (a): RegisteredApp => ({
          id: a.id,
          appName: a.appName,
          vendorName: a.vendorName,
          logoUrl: a.logoUrl,
          checkType: a.checkType,
          statusUrl: a.statusUrl,
        }),
      );
    if (toAdd.length > 0) onBulkAddApps(toAdd);
    onOpenChange(false);
  };

  // Group by category in defined order
  const byCategory = CATEGORY_ORDER.reduce<Record<string, PopularApp[]>>((acc, cat) => {
    const items = apps.filter((a) => a.category === cat);
    if (items.length > 0) acc[cat] = items;
    return acc;
  }, {});

  const selectedCount = [...selected].filter((id) => !existingIds.has(id)).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-[600px]">
        <DialogHeader className="border-b px-5 py-4">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <DialogTitle className="text-sm font-semibold">Quick Setup</DialogTitle>
          </div>
          <DialogDescription className="text-xs">
            Select the apps your team uses — status URLs are auto-detected per vendor.
          </DialogDescription>
        </DialogHeader>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="p-2">
              {["Automation", "Time Tracking", "Testing & QA", "Diagrams"].map((cat) => (
                <CategorySkeleton key={cat} label={cat} />
              ))}
            </div>
          )}

          {error && (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <p className="text-sm text-muted-foreground">
                Failed to load app list. Check your connection and try again.
              </p>
            </div>
          )}

          {!loading && !error && apps.length > 0 && (
            <div className="p-2">
              {/* Select all row */}
              <label className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 hover:bg-muted/50">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = !allSelected && !noneSelected;
                  }}
                  onChange={toggleAll}
                  className="h-4 w-4 cursor-pointer accent-primary"
                />
                <span className="text-xs font-medium text-muted-foreground">
                  Select all
                </span>
                {selectedCount > 0 && (
                  <span className="ml-auto text-xs text-muted-foreground">
                    {selectedCount} selected
                  </span>
                )}
              </label>

              <div className="my-1 border-t" />

              {/* Categories */}
              {Object.entries(byCategory).map(([cat, catApps]) => (
                <div key={cat}>
                  <div className="px-3 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {cat}
                  </div>
                  {catApps.map((app) => {
                    const isAdded = existingIds.has(app.id);
                    const isChecked = selected.has(app.id);
                    return (
                      <label
                        key={app.id}
                        className={`flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 transition-colors ${
                          isAdded ? "opacity-50" : "hover:bg-muted/50"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          disabled={isAdded}
                          onChange={() => !isAdded && toggleOne(app.id)}
                          className="h-4 w-4 cursor-pointer accent-primary disabled:cursor-not-allowed"
                        />
                        <AppLogo
                          src={app.logoUrl}
                          alt={app.appName}
                          className="h-8 w-8 shrink-0"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-sm font-medium leading-tight">
                              {app.appName}
                            </span>
                            {isAdded && (
                              <Badge
                                variant="secondary"
                                className="shrink-0 text-[10px] leading-tight"
                              >
                                Added
                              </Badge>
                            )}
                          </div>
                          <p className="truncate text-xs text-muted-foreground">
                            {app.vendorName}
                          </p>
                        </div>
                        <div className="shrink-0">
                          {app.statusUrl ? (
                            <span className="flex items-center gap-0.5 text-xs font-medium text-emerald-600">
                              <CheckCircle2 className="h-3.5 w-3.5" />
                              Auto
                            </span>
                          ) : (
                            <span className="text-xs text-amber-500">No URL</span>
                          )}
                        </div>
                      </label>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>

        <DialogFooter className="border-t px-5 py-3">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={selectedCount === 0} onClick={handleAdd}>
            Add {selectedCount > 0 ? `${selectedCount} app${selectedCount !== 1 ? "s" : ""}` : "apps"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
