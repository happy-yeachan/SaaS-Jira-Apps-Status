"use client";

import { useState } from "react";
import {
  ArrowLeft,
  CheckCircle2,
  Cloud,
  Download,
  Info,
  Loader2,
  Search,
  Store,
} from "lucide-react";
import { AppLogo } from "@/components/app-logo";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "@/components/ui/input-group";
import { cn } from "@/lib/utils";
import type { RegisteredApp } from "@/types";

interface JiraImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with only the NEW apps (existing IDs already filtered out). */
  onImportApps: (apps: RegisteredApp[]) => void;
  existingIds?: Set<string>;
}

// statusSource is returned by the API so we can show per-app badges.
// It is stripped before the apps are saved to dashboard state.
type StatusSource = "map" | "discovered" | "none" | "serverless";

interface ImportedApp extends RegisteredApp {
  statusSource: StatusSource;
  /** true when the plugin key was found on the Atlassian Marketplace API */
  onMarketplace: boolean;
}

interface FetchResult {
  apps: ImportedApp[];
  total: number;
  mappedCount: number;
  discoveredCount: number;
  serverlessCount: number;
  marketplaceCount: number;
  connectApiBlocked: boolean;
  graphqlAppsFound: number;
  probedAppsFound: number;
}

type Step = "form" | "results";

function JiraResultRow({
  app,
  existingIds,
}: {
  app: ImportedApp;
  existingIds: Set<string>;
}) {
  const isAlreadyAdded = existingIds.has(app.id);
  return (
    <div
      className={cn(
        "flex items-center gap-3 px-4 py-2.5",
        isAlreadyAdded && "opacity-50",
      )}
    >
      <AppLogo
        src={app.logoUrl}
        alt={app.appName}
        className="h-8 w-8"
      />

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium leading-tight">
          {app.appName}
        </p>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {app.vendorName}
        </p>
      </div>

      <div className="flex shrink-0 flex-col items-end gap-1">
        {/* Status source badge */}
        {isAlreadyAdded ? (
          <Badge variant="secondary" className="text-[10px]">
            Added
          </Badge>
        ) : app.statusSource === "map" ? (
          <span className="flex items-center gap-1 text-[11px] font-medium text-emerald-600">
            <CheckCircle2 className="h-3.5 w-3.5" />
            Mapped
          </span>
        ) : app.statusSource === "discovered" ? (
          <span className="flex items-center gap-1 text-[11px] font-medium text-blue-500">
            <Search className="h-3.5 w-3.5" />
            Discovered
          </span>
        ) : app.statusSource === "serverless" ? (
          <span className="flex items-center gap-1 text-[11px] font-medium text-purple-600 dark:text-purple-400">
            <Cloud className="h-3.5 w-3.5" />
            Serverless
          </span>
        ) : (
          <span className="text-[11px] text-muted-foreground">No status page</span>
        )}

        {/* Marketplace indicator */}
        {!isAlreadyAdded && (
          app.onMarketplace ? (
            <span className="flex items-center gap-0.5 text-[10px] text-sky-500">
              <Store className="h-3 w-3" />
              Marketplace
            </span>
          ) : (
            <span className="text-[10px] text-muted-foreground/60">
              Unlisted
            </span>
          )
        )}
      </div>
    </div>
  );
}

export function JiraImportDialog({
  open,
  onOpenChange,
  onImportApps,
  existingIds = new Set(),
}: JiraImportDialogProps) {
  const [step, setStep] = useState<Step>("form");

  // Form fields — intentionally NOT persisted to localStorage
  const [domainSuffix, setDomainSuffix] = useState(""); // part after https://
  const [email, setEmail] = useState("");
  const [apiToken, setApiToken] = useState("");

  // Track which fields the user has interacted with so errors only show after first touch
  const [touched, setTouched] = useState({ domain: false, email: false, token: false });

  // API-returned errors mapped to specific fields (or "general" for unmapped ones)
  const [fieldErrors, setFieldErrors] = useState<{
    domain?: string;
    email?: string;
    token?: string;
    general?: string;
  }>({});

  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<FetchResult | null>(null);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) {
      setStep("form");
      setFieldErrors({});
      setTouched({ domain: false, email: false, token: false });
      setResult(null);
      setIsLoading(false);
      // Credentials are intentionally cleared on close — never stored
      setDomainSuffix("");
      setEmail("");
      setApiToken("");
    }
    onOpenChange(nextOpen);
  };


  const handleFetch = async () => {
    // Reveal validation errors on all fields before attempting the fetch
    setTouched({ domain: true, email: true, token: true });
    setFieldErrors({});
    setIsLoading(true);

    const fullDomain = `https://${domainSuffix.trim().replace(/\/+$/, "")}`;

    try {
      const res = await fetch("/api/jira/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Token sent in body to our proxy — never appears in URL or browser history
        body: JSON.stringify({
          jiraDomain: fullDomain,
          email: email.trim(),
          apiToken,
        }),
      });
      const data = (await res.json()) as {
        apps?: ImportedApp[];
        total?: number;
        mappedCount?: number;
        discoveredCount?: number;
        serverlessCount?: number;
        marketplaceCount?: number;
        connectApiBlocked?: boolean;
        graphqlAppsFound?: number;
        probedAppsFound?: number;
        error?: string;
      };

      if (!res.ok) {
        const msg = data.error ?? `Error ${res.status}`;
        // Map the API error to the most relevant field so the user sees it inline
        if (res.status === 401) {
          setFieldErrors({ token: msg });
        } else if (res.status === 403) {
          setFieldErrors({ token: msg });
        } else if (res.status === 404 || res.status === 502) {
          setFieldErrors({ domain: msg });
        } else {
          setFieldErrors({ general: msg });
        }
        return;
      }

      setResult({
        apps: data.apps ?? [],
        total: data.total ?? 0,
        mappedCount: data.mappedCount ?? 0,
        discoveredCount: data.discoveredCount ?? 0,
        serverlessCount: data.serverlessCount ?? 0,
        marketplaceCount: data.marketplaceCount ?? 0,
        connectApiBlocked: data.connectApiBlocked ?? false,
        graphqlAppsFound: data.graphqlAppsFound ?? 0,
        probedAppsFound: data.probedAppsFound ?? 0,
      });
      setStep("results");
    } catch (err) {
      setFieldErrors({
        general: err instanceof Error ? err.message : "Network error. Is the dev server running?",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleImport = () => {
    if (!result) return;
    // Strip the UI-only statusSource field. Pass the full list so the dashboard
    // can merge: `statusUrl` / `checkType` from the server overwrite stale
    // localStorage data for apps that were already imported.
    const toImport = result.apps.map(({ statusSource: _s, ...app }) => app);
    onImportApps(toImport);
    handleOpenChange(false);
  };

  // ── Derived ─────────────────────────────────────────────────────────────
  const newApps = result?.apps.filter((a) => !existingIds.has(a.id)) ?? [];
  const alreadyAddedCount = (result?.total ?? 0) - newApps.length;

  const thirdPartyApps =
    result?.apps.filter((a) => a.statusSource !== "serverless") ?? [];
  const serverlessAppList =
    result?.apps.filter((a) => a.statusSource === "serverless") ?? [];

  // Client-side validation messages — shown after the user touches each field
  const domainError =
    touched.domain && !domainSuffix.trim() ? "Jira Site URL을 입력해주세요." : undefined;
  const emailError =
    touched.email && !email.trim().includes("@") ? "유효한 이메일 주소를 입력해주세요." : undefined;
  const tokenError =
    touched.token && !apiToken.trim() ? "API 토큰을 입력해주세요." : undefined;

  const isFormValid =
    domainSuffix.trim().length > 0 &&
    email.trim().includes("@") &&
    apiToken.trim().length > 0;

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-[520px]">
        {/* Header */}
        <DialogHeader className="border-b px-4 py-3">
          <DialogTitle className="text-sm font-semibold">
            {step === "form"
              ? "Import from Jira"
              : `Found ${result?.total ?? 0} installed apps`}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {step === "form"
              ? "Jira 관리자 이메일과 API 토큰으로 설치된 앱을 가져옵니다."
              : [
                  result?.marketplaceCount
                    ? `${result.marketplaceCount} on marketplace`
                    : null,
                  result?.mappedCount
                    ? `${result.mappedCount} status mapped`
                    : null,
                  result?.discoveredCount
                    ? `${result.discoveredCount} auto-discovered`
                    : null,
                  (() => {
                    const noUrl =
                      (result?.total ?? 0) -
                      (result?.mappedCount ?? 0) -
                      (result?.discoveredCount ?? 0) -
                      (result?.serverlessCount ?? 0);
                    return noUrl > 0 ? `${noUrl} no status page` : null;
                  })(),
                  (result?.serverlessCount ?? 0) > 0
                    ? `${result?.serverlessCount} serverless (Forge)`
                    : null,
                  alreadyAddedCount > 0
                    ? `${alreadyAddedCount} already added`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
          </DialogDescription>
        </DialogHeader>

        {/* ── Step 1: Credential form ─────────────────────────────────── */}
        {step === "form" && (
          <>
            <div className="space-y-4 px-4 py-4">
              {/* Jira Site URL */}
              <div className="space-y-1.5">
                <label htmlFor="jira-domain" className="text-xs font-medium leading-none">
                  Jira Site URL
                </label>
                <InputGroup>
                  <InputGroupAddon>
                    <InputGroupText className="text-xs">https://</InputGroupText>
                  </InputGroupAddon>
                  <InputGroupInput
                    id="jira-domain"
                    type="text"
                    placeholder="yourcompany.atlassian.net"
                    value={domainSuffix}
                    aria-invalid={(domainError ?? fieldErrors.domain) ? true : undefined}
                    onChange={(e) => {
                      let val = e.target.value;
                      if (val.startsWith("https://")) val = val.slice(8);
                      if (val.startsWith("http://")) val = val.slice(7);
                      setDomainSuffix(val);
                      if (fieldErrors.domain) setFieldErrors((p) => ({ ...p, domain: undefined }));
                    }}
                    onBlur={() => setTouched((p) => ({ ...p, domain: true }))}
                    className="text-sm"
                  />
                </InputGroup>
                {(domainError ?? fieldErrors.domain) && (
                  <p className="text-xs text-destructive">{domainError ?? fieldErrors.domain}</p>
                )}
              </div>

              {/* Email */}
              <div className="space-y-1.5">
                <label htmlFor="jira-email" className="text-xs font-medium leading-none">
                  Admin Email
                </label>
                <Input
                  id="jira-email"
                  type="email"
                  placeholder="admin@company.com"
                  value={email}
                  aria-invalid={(emailError ?? fieldErrors.email) ? true : undefined}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (fieldErrors.email) setFieldErrors((p) => ({ ...p, email: undefined }));
                  }}
                  onBlur={() => setTouched((p) => ({ ...p, email: true }))}
                  className="h-8 text-sm"
                />
                {(emailError ?? fieldErrors.email) && (
                  <p className="text-xs text-destructive">{emailError ?? fieldErrors.email}</p>
                )}
              </div>

              {/* API Token */}
              <div className="space-y-1.5">
                <div className="flex items-baseline justify-between">
                  <label htmlFor="jira-token" className="text-xs font-medium leading-none">
                    API Token
                  </label>
                  <a
                    href="https://id.atlassian.com/manage-profile/security/api-tokens"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    Generate token ↗
                  </a>
                </div>
                <Input
                  id="jira-token"
                  type="password"
                  placeholder="••••••••••••••••••••"
                  value={apiToken}
                  aria-invalid={(tokenError ?? fieldErrors.token) ? true : undefined}
                  onChange={(e) => {
                    setApiToken(e.target.value);
                    if (fieldErrors.token) setFieldErrors((p) => ({ ...p, token: undefined }));
                  }}
                  onBlur={() => setTouched((p) => ({ ...p, token: true }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && isFormValid && !isLoading) void handleFetch();
                  }}
                  className="h-8 text-sm"
                />
                {(tokenError ?? fieldErrors.token) && (
                  <p className="text-xs text-destructive">{tokenError ?? fieldErrors.token}</p>
                )}
              </div>

              {fieldErrors.general && (
                <p className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">
                  {fieldErrors.general}
                </p>
              )}
            </div>

            <div className="flex flex-col gap-2 border-t bg-muted/30 px-4 py-3">
              <Button
                size="sm"
                className="w-full"
                disabled={isLoading || !isFormValid}
                onClick={() => void handleFetch()}
              >
                {isLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                {isLoading ? "Fetching & discovering status pages…" : "Fetch Installed Apps"}
              </Button>

              <div className="flex items-start gap-1.5 rounded-md bg-blue-50 px-2.5 py-2 dark:bg-blue-950/40">
                <Info className="mt-0.5 h-3 w-3 shrink-0 text-blue-500" />
                <p className="text-[10px] leading-relaxed text-blue-700 dark:text-blue-300">
                  자격 증명은 이 요청에만 사용되며 저장되지 않습니다.
                </p>
              </div>
            </div>
          </>
        )}

        {/* ── Step 2: Results list ────────────────────────────────────── */}
        {step === "results" && (
          <>
            {/* Connect API detection notice */}
            {result?.connectApiBlocked && (
              <div className={`flex items-start gap-2 border-b px-4 py-3 ${
                (result.probedAppsFound ?? 0) > 0 || (result.graphqlAppsFound ?? 0) > 0
                  ? "bg-green-50 dark:bg-green-950/30"
                  : "bg-blue-50 dark:bg-blue-950/30"
              }`}>
                <Info className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
                  (result.probedAppsFound ?? 0) > 0 || (result.graphqlAppsFound ?? 0) > 0
                    ? "text-green-500"
                    : "text-blue-500"
                }`} />
                <div className="space-y-0.5">
                  {(result.probedAppsFound ?? 0) > 0 || (result.graphqlAppsFound ?? 0) > 0 ? (
                    <>
                      <p className="text-xs font-medium text-green-800 dark:text-green-300">
                        Connect 앱 {(result.probedAppsFound ?? 0) + (result.graphqlAppsFound ?? 0)}개 감지됨
                      </p>
                      <p className="text-[11px] text-green-700 dark:text-green-400">
                        Connect API는 차단되었지만 앱별 엔드포인트 탐색으로 설치된 앱을 감지했습니다.
                        {(result.graphqlAppsFound ?? 0) > 0 && ` (GraphQL: ${result.graphqlAppsFound}개)`}
                        {(result.probedAppsFound ?? 0) > 0 && ` (엔드포인트 탐색: ${result.probedAppsFound}개)`}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-xs font-medium text-blue-800 dark:text-blue-300">
                        ScriptRunner, Tempo 등 Connect 앱은 미포함
                      </p>
                      <p className="text-[11px] text-blue-700 dark:text-blue-400">
                        Atlassian의 정책으로 API 토큰으로는 Connect 앱 목록을 가져올 수 없습니다.
                        앱별 엔드포인트 탐색도 설치된 항목을 찾지 못했습니다.
                      </p>
                    </>
                  )}
                </div>
              </div>
            )}
            <div className="max-h-[480px] min-h-[120px] overflow-y-auto">
              {newApps.length === 0 && alreadyAddedCount > 0 ? (
                <p className="px-4 py-10 text-center text-xs text-muted-foreground">
                  All fetched apps are already in your dashboard.
                </p>
              ) : (
                <div className="flex flex-col">
                  {thirdPartyApps.length > 0 && (
                    <div>
                      <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
                        <h3 className="text-xs font-semibold">
                          Third-party vendor apps
                        </h3>
                        <Badge variant="secondary" className="h-5 text-[10px]">
                          {thirdPartyApps.length}
                        </Badge>
                      </div>
                      <div className="divide-y">
                        {thirdPartyApps.map((app) => (
                          <JiraResultRow
                            key={app.id}
                            app={app}
                            existingIds={existingIds}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {serverlessAppList.length > 0 && (
                    <div className="border-t">
                      <div className="flex items-center gap-2 border-b bg-muted/30 px-4 py-2.5">
                        <h3 className="text-xs font-semibold">
                          Atlassian serverless
                        </h3>
                        <Badge
                          variant="outline"
                          className="h-5 border-purple-200 bg-purple-50 text-[10px] text-purple-700 dark:border-purple-800 dark:bg-purple-950/50 dark:text-purple-300"
                        >
                          <Cloud className="mr-0.5 h-3 w-3" />
                          {serverlessAppList.length}
                        </Badge>
                      </div>
                      <p className="px-4 py-2 text-[11px] text-muted-foreground">
                        Forge and ecosystem apps on Atlassian cloud infrastructure. Status
                        follows the developer platform page.
                      </p>
                      <div className="divide-y">
                        {serverlessAppList.map((app) => (
                          <JiraResultRow
                            key={app.id}
                            app={app}
                            existingIds={existingIds}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Results footer */}
            <div className="flex items-center justify-between gap-2 border-t bg-muted/30 px-4 py-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setStep("form")}
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back
              </Button>
              <Button
                size="sm"
                disabled={(result?.apps.length ?? 0) === 0}
                onClick={handleImport}
              >
                Import / update {result?.apps.length ?? 0} App
                {(result?.apps.length ?? 0) !== 1 ? "s" : ""}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
