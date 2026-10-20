/**
 * Tells the API about an error the app hit (backend client-errors.controller.ts),
 * so a page that breaks in someone's browser or the Mac app can be fixed without
 * a screenshot. Only the error, its stack, the page path and the browser: never
 * mail content. A failed report is dropped.
 */
export function reportError(kind: string, error: unknown, componentStack?: string | null): void {
  const err = error instanceof Error ? error : new Error(String(error));
  try {
    void fetch("/api/v1/client-errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      keepalive: true,
      body: JSON.stringify({
        kind,
        message: `${err.name}: ${err.message}`,
        stack: err.stack ?? null,
        componentStack: componentStack ?? null,
        page: location.pathname,
        userAgent: navigator.userAgent,
      }),
    }).catch(() => {});
  } catch {
    /* nothing to do */
  }
}

/** Uncaught errors and rejected promises anywhere in the page. */
export function reportUncaughtErrors(): void {
  addEventListener("error", (e) => {
    // A script or picture that failed to load isn't a code error (index.html handles ours).
    if (!(e instanceof ErrorEvent) || !e.error) return;
    reportError("uncaught", e.error);
  });
  addEventListener("unhandledrejection", (e) => reportError("rejection", e.reason));
}
