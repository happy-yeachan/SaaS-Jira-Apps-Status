"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { AppLogo } from "@/components/app-logo";
import { Badge } from "@/components/ui/badge";
import {
  Command,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { type MarketplaceSearchItem, type RegisteredApp } from "@/types";

interface AddAppDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAddApp: (app: RegisteredApp) => void;
  existingIds?: Set<string>;
}

function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

function ResultSkeleton() {
  return (
    <div className="space-y-0.5 p-1">
      {[1, 2, 3].map((i) => (
        <div
          key={i}
          className="flex animate-pulse items-center gap-3 rounded-md px-3 py-2.5"
        >
          <div className="h-9 w-9 shrink-0 rounded-lg bg-muted" />
          <div className="flex-1 space-y-1.5">
            <div className="h-3 w-36 rounded bg-muted" />
            <div className="h-2.5 w-24 rounded bg-muted" />
          </div>
          <div className="h-5 w-16 shrink-0 rounded-full bg-muted" />
        </div>
      ))}
    </div>
  );
}

export function AddAppDialog({
  open,
  onOpenChange,
  onAddApp,
  existingIds = new Set(),
}: AddAppDialogProps) {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 450);
  const [results, setResults] = useState<MarketplaceSearchItem[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);

  // Reset via event handler — avoids synchronous setState inside an effect
  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setQuery("");
      setResults([]);
      setHasSearched(false);
      setIsSearching(false);
    }
    onOpenChange(nextOpen);
  };

  // Debounced search — fires only after 450 ms of no typing
  useEffect(() => {
    if (debouncedQuery.trim().length < 2) return;

    const controller = new AbortController();

    const doSearch = async () => {
      setIsSearching(true);
      try {
        const res = await fetch(
          `/api/marketplace/search?query=${encodeURIComponent(debouncedQuery)}&limit=50`,
          { signal: controller.signal },
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { items?: MarketplaceSearchItem[] };
        setResults(data.items ?? []);
      } catch (err) {
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          setResults([]);
        }
      } finally {
        if (!controller.signal.aborted) {
          setIsSearching(false);
          setHasSearched(true);
        }
      }
    };

    void doSearch();
    return () => controller.abort();
  }, [debouncedQuery]);

  // Zero-input add: statusUrl & checkType are already resolved server-side
  const handleSelect = (item: MarketplaceSearchItem) => {
    if (existingIds.has(item.id)) return;
    onAddApp({
      id: item.id,
      appName: item.appName,
      vendorName: item.vendorName,
      logoUrl: item.logoUrl,
      checkType: item.checkType,
      statusUrl: item.statusUrl,
    });
  };

  const liveIsLong = query.trim().length >= 2;
  const debouncedIsLong = debouncedQuery.trim().length >= 2;

  const showHint = !liveIsLong;
  const showSkeleton = liveIsLong && (isSearching || !debouncedIsLong || !hasSearched);
  const showEmpty = debouncedIsLong && !isSearching && hasSearched && results.length === 0;
  const showResults = debouncedIsLong && !isSearching && results.length > 0;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[480px]">
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle className="text-sm font-semibold">
            Add App from Atlassian Marketplace
          </DialogTitle>
          <DialogDescription className="text-xs">
            Search and click to add — status URL is auto-detected per vendor, no
            form needed.
          </DialogDescription>
        </DialogHeader>

        {/*
          shouldFilter={false} — disables cmdk's built-in fuzzy filter so the
          list renders exactly in the order returned by our backend proxy, which
          already applies: exact match → starts-with → contains → API relevance.
        */}
        <Command shouldFilter={false} className="rounded-none border-0 shadow-none">
          {/* Input row — relative wrapper lets the spinner overlay the search icon */}
          <div className="relative border-b">
            <CommandInput
              value={query}
              onValueChange={setQuery}
              autoFocus
              placeholder="Type app name (e.g. draw.io, Zephyr, Tempo…)"
            />
            {isSearching && (
              <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            )}
          </div>

          {/*
            CommandList is the scroll container.
            max-h-[480px] + overflow-y-auto keeps up to ~10 items visible
            while making the remaining ~40 results reachable by scrolling.
            min-h-[180px] prevents jarring height collapses between states.
          */}
          <CommandList className="max-h-[480px] min-h-[180px] overflow-y-auto p-0">
            {showHint && (
              <p className="px-4 py-10 text-center text-xs text-muted-foreground">
                Type at least 2 characters to search the Marketplace.
              </p>
            )}

            {showSkeleton && <ResultSkeleton />}

            {showEmpty && (
              <p className="px-4 py-10 text-center text-xs text-muted-foreground">
                No apps found for &ldquo;{debouncedQuery}&rdquo;.
              </p>
            )}

            {showResults &&
              results.map((item) => {
                const isAlreadyAdded = existingIds.has(item.id);
                const isSupported = item.statusUrl !== "";

                return (
                  /*
                    CommandItem renders a <div role="option"> — never a <button>.
                    This avoids the "button inside button" nesting error that plagued
                    the earlier plain-<button> approach inside Dialog.
                    Keyboard nav (↑ ↓ Enter) is provided by cmdk for free.
                  */
                  <CommandItem
                    key={item.id}
                    value={item.id}
                    disabled={isAlreadyAdded}
                    onSelect={() => handleSelect(item)}
                    className="gap-3 px-3 py-2.5 [&>svg:last-child]:hidden"
                  >
                    {/* App logo — plain <img> with no-referrer bypasses CDN 403 */}
                    <AppLogo
                      src={item.logoUrl}
                      alt={item.appName}
                      className="h-9 w-9"
                    />

                    {/* App name + vendor */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium leading-tight">
                          {item.appName}
                        </span>
                        {isAlreadyAdded && (
                          <Badge
                            variant="secondary"
                            className="shrink-0 text-[10px] leading-tight"
                          >
                            Added
                          </Badge>
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {item.vendorName}
                      </p>
                    </div>

                    {/* Status URL indicator (resolved server-side via VENDOR_STATUS_MAP) */}
                    <div className="shrink-0">
                      {isSupported ? (
                        <span className="flex items-center gap-0.5 text-xs font-medium text-emerald-600">
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Auto
                        </span>
                      ) : (
                        <span className="text-xs text-amber-500">No URL</span>
                      )}
                    </div>
                  </CommandItem>
                );
              })}
          </CommandList>
        </Command>

        {/* Footer legend */}
        <div className="border-t bg-muted/30 px-4 py-2">
          <p className="text-[10px] text-muted-foreground">
            <span className="font-medium text-emerald-600">Auto</span> — status
            URL pre-mapped for this vendor. &nbsp;
            <span className="font-medium text-amber-500">No URL</span> — added
            as &ldquo;Not configured&rdquo;.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
