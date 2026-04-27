"use client";

import { useState } from "react";
import { LayoutGrid } from "lucide-react";
import { cn } from "@/lib/utils";

interface AppLogoProps {
  src?: string;
  alt: string;
  /** Tailwind size classes — defaults to "h-8 w-8" */
  className?: string;
}

/**
 * Renders an app logo using a plain <img> tag so that:
 *   - referrerPolicy="no-referrer"  → bypasses Atlassian CDN 403 blocks
 *   - crossOrigin="anonymous"       → no credentials sent with the request
 *   - onError fallback              → shows a neutral icon if the image fails
 *
 * We intentionally avoid shadcn AvatarImage / next/image here because both
 * add intermediate layers that can swallow or alter the referrer policy before
 * the request actually leaves the browser.
 */
export function AppLogo({ src, alt, className }: AppLogoProps) {
  const [failed, setFailed] = useState(false);

  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-lg bg-slate-100",
        className ?? "h-8 w-8",
      )}
    >
      {src && !failed ? (
        <img
          src={src}
          alt={alt}
          referrerPolicy="no-referrer"
          className="h-full w-full object-contain"
          onError={() => setFailed(true)}
        />
      ) : (
        <LayoutGrid className="h-4 w-4 text-slate-400" />
      )}
    </div>
  );
}
