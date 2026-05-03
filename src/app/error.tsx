"use client";

import { useEffect } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[error.tsx]", error);
  }, [error]);

  return (
    <main className="flex flex-1 flex-col items-center justify-center px-6 py-20 text-center">
      <AlertTriangle className="mb-4 h-12 w-12 text-amber-500" />
      <h1 className="text-base font-semibold">Something went wrong</h1>
      <p className="mt-1 max-w-md text-sm text-muted-foreground">
        The dashboard hit an unexpected error. Your stored apps are safe — they live in this
        browser&apos;s localStorage and weren&apos;t touched.
      </p>
      {error.digest && (
        <p className="mt-3 font-mono text-xs text-muted-foreground/80">digest: {error.digest}</p>
      )}
      <Button onClick={reset} className="mt-6">
        <RefreshCw className="mr-1.5 h-4 w-4" />
        Try again
      </Button>
    </main>
  );
}
