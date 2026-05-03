"use client";

import { CheckCircle2, PlusCircle, BarChart3, Zap, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface OnboardingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function OnboardingDialog({ open, onOpenChange }: OnboardingDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            <DialogTitle className="text-lg">Welcome to Status Dashboard</DialogTitle>
          </div>
          <DialogDescription className="text-sm">
            Monitor the health of all Atlassian Marketplace apps installed in your Jira.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Feature 1 */}
          <div className="flex gap-3">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
            </div>
            <div>
              <h4 className="text-sm font-semibold">Quick Setup</h4>
              <p className="text-xs text-muted-foreground">
                Start with curated popular apps — status URLs are auto-detected per vendor. No
                manual entry needed.
              </p>
            </div>
          </div>

          {/* Feature 2 */}
          <div className="flex gap-3">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10">
              <PlusCircle className="h-3.5 w-3.5 text-primary" />
            </div>
            <div>
              <h4 className="text-sm font-semibold">Add Apps Manually</h4>
              <p className="text-xs text-muted-foreground">
                Search the Marketplace by name or paste custom status page URLs for unlisted
                vendors.
              </p>
            </div>
          </div>

          {/* Feature 3 */}
          <div className="flex gap-3">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10">
              <Zap className="h-3.5 w-3.5 text-primary" />
            </div>
            <div>
              <h4 className="text-sm font-semibold">Real-Time Status</h4>
              <p className="text-xs text-muted-foreground">
                Check health instantly or set up auto-refresh (1 min, 5 min, 30 min). No
                authentication required.
              </p>
            </div>
          </div>

          {/* Feature 4 */}
          <div className="flex gap-3">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10">
              <BarChart3 className="h-3.5 w-3.5 text-primary" />
            </div>
            <div>
              <h4 className="text-sm font-semibold">History & Uptime</h4>
              <p className="text-xs text-muted-foreground">
                30-day heartbeat bars show uptime trends. All data stored locally in your
                browser.
              </p>
            </div>
          </div>

          {/* Feature 5 */}
          <div className="flex gap-3">
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10">
              <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
            </div>
            <div>
              <h4 className="text-sm font-semibold">Jira Integration (Optional)</h4>
              <p className="text-xs text-muted-foreground">
                Import your installed apps directly from Jira using Basic Auth. Pre-fetches
                status URLs for known vendors.
              </p>
            </div>
          </div>
        </div>

        <div className="border-t pt-4">
          <p className="mb-3 text-xs text-muted-foreground">
            💾 <strong>Privacy note:</strong> All apps and history are stored only in your browser's
            localStorage. Nothing is sent to external servers except vendor status API calls.
          </p>
        </div>

        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Get Started</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
