import { Component, type ErrorInfo, type ReactNode } from "react";
import { useLocation } from "react-router-dom";

type Props = { children: ReactNode; resetKey: string };
type State = { error: Error | null };

/**
 * A screen that throws while rendering would otherwise unmount the whole app
 * and leave an empty window (the Mac app showed only its dark background).
 * This shows what went wrong, with a way out; going to another page tries again.
 */
class Boundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Missive couldn't show this page:", error, info.componentStack);
  }

  override componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
        <div className="max-w-md w-full space-y-4">
          <h1 className="text-lg font-semibold">Missive couldn't show this page</h1>
          <p className="text-sm text-muted-foreground">Something on it broke. Reloading usually fixes it; if it keeps happening, the message below says what went wrong.</p>
          <pre className="text-xs whitespace-pre-wrap break-words rounded-md border border-border bg-muted/40 p-3 max-h-48 overflow-auto">
            {error.name}: {error.message}
          </pre>
          <div className="flex gap-2">
            <button className="rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-sm font-medium" onClick={() => location.reload()}>
              Reload
            </button>
            <a href="/inbox" className="rounded-md border border-border px-3 py-1.5 text-sm font-medium">
              Go to Inbox
            </a>
          </div>
        </div>
      </div>
    );
  }
}

/** Around the app: a fresh try each time the page changes. */
export function ErrorScreen({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return <Boundary resetKey={pathname}>{children}</Boundary>;
}
