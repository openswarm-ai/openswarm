import React from 'react';

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

/**
 * Visible error surface for the App Builder template.
 *
 * When the agent's edits introduce a runtime React error (most commonly:
 * a missing import after a multi-edit refactor, an `Invalid hook call`
 * from duplicate React copies / hooks-called-conditionally, or a typo
 * in JSX), React unmounts the whole tree and the iframe goes black —
 * the user just sees an empty preview pane and has no idea what
 * happened. This boundary catches those errors, renders a readable
 * error card in their place, AND mirrors the error up to the OpenSwarm
 * host (via window.parent.postMessage + console.error, both of which
 * the webview-preload bridge already forwards) so the App Builder
 * agent's `post_tool_hook` can see what went wrong on its next turn
 * and self-heal without the user having to copy-paste the stack.
 *
 * Kept as a single small class component with no MUI / theme imports
 * so it itself can't crash the boundary — it's the last line of
 * defense and has to be import-minimal on purpose.
 */
class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, errorInfo: null };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidMount(): void {
    // Clean first mount: nothing caught, so the app is in a good render
    // state and the ready beacon is allowed.
    if (!this.state.error) {
      window.__openswarm_render_failed = false;
      window.__openswarm_last_error = '';
    }
  }

  componentDidUpdate(_prevProps: ErrorBoundaryProps, prevState: ErrorBoundaryState): void {
    // Fast Refresh retried the previously-broken subtree and it rendered:
    // re-allow the ready beacon so index.tsx's vite:afterUpdate can report ok.
    if (prevState.error && !this.state.error) {
      window.__openswarm_render_failed = false;
      window.__openswarm_last_error = '';
    }
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    this.setState({ errorInfo });
    // Suppress the post-mount "ready" beacon in index.tsx and re-arm the
    // window-error gate: the app is not in a rendered state right now.
    // Stash the message so the HMR handler can re-assert this error after
    // an unrelated edit (which resets the host's render-state to None).
    window.__openswarm_render_failed = true;
    window.__openswarm_rendered = false;
    window.__openswarm_last_error =
      `${error?.message ?? String(error)}\n${errorInfo?.componentStack ?? ''}`.trim();
    // Two channels so the OpenSwarm host's webview-preload bridge can
    // pick this up regardless of which one it taps:
    //   1. console.error — forwarded as a `[FRONTEND]` line into the
    //      App Builder's Terminal pane, which the agent's
    //      drain_errors_for_path hook reads on its next tool call.
    //   2. postMessage — host-side listeners (if/when added) can read
    //      the structured payload without parsing console output.
    // eslint-disable-next-line no-console
    console.error(
      '[openswarm:app-error]',
      error?.message ?? String(error),
      errorInfo?.componentStack ?? '',
    );
    try {
      window.parent.postMessage(
        {
          type: 'openswarm:app-error',
          message: error?.message ?? String(error),
          stack: error?.stack,
          componentStack: errorInfo?.componentStack,
        },
        '*',
      );
    } catch {
      /* postMessage to opaque parent can throw — best-effort only */
    }
  }

  handleReload = (): void => {
    this.setState({ error: null, errorInfo: null });
    window.location.reload();
  };

  render(): React.ReactNode {
    const { error, errorInfo } = this.state;
    if (!error) return this.props.children;

    // Inline-styled so even a busted theme context can't take this
    // surface down with it.
    const wrapStyle: React.CSSProperties = {
      position: 'fixed',
      inset: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
      background: '#1a1918',
      color: '#FAF9F5',
      fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
      zIndex: 99999,
      overflow: 'auto',
    };
    const cardStyle: React.CSSProperties = {
      maxWidth: 640,
      width: '100%',
      padding: 24,
      borderRadius: 14,
      background: '#262624',
      border: '1px solid rgba(196,99,58,0.4)',
      boxShadow: '0 12px 40px rgba(0,0,0,0.3)',
    };
    const headingStyle: React.CSSProperties = {
      margin: 0,
      fontSize: 16,
      fontWeight: 600,
      color: '#c4633a',
      marginBottom: 6,
      letterSpacing: '-0.01em',
    };
    const subStyle: React.CSSProperties = {
      margin: 0,
      fontSize: 13,
      color: '#9C9A92',
      marginBottom: 16,
      lineHeight: 1.5,
    };
    const codeStyle: React.CSSProperties = {
      display: 'block',
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.5,
      background: '#1f1e1b',
      color: '#FAF9F5',
      padding: 12,
      borderRadius: 8,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      maxHeight: 220,
      overflow: 'auto',
      marginBottom: 12,
    };
    const buttonStyle: React.CSSProperties = {
      appearance: 'none',
      border: 'none',
      background: '#c4633a',
      color: '#FAF9F5',
      fontSize: 13,
      fontWeight: 600,
      padding: '8px 16px',
      borderRadius: 999,
      cursor: 'pointer',
      fontFamily: 'inherit',
    };

    return (
      <div style={wrapStyle}>
        <div style={cardStyle}>
          <h2 style={headingStyle}>This app hit a snag.</h2>
          <p style={subStyle}>
            The agent's most recent edit introduced an error that prevents
            the preview from rendering. Ask the agent to fix it — the
            details below are already piped to its Terminal so it can
            see them on the next turn.
          </p>
          <code style={codeStyle}>
            {error.message || String(error)}
          </code>
          {errorInfo?.componentStack && (
            <code style={{ ...codeStyle, fontSize: 11, color: '#9C9A92' }}>
              {errorInfo.componentStack.trim()}
            </code>
          )}
          <button type="button" style={buttonStyle} onClick={this.handleReload}>
            Reload preview
          </button>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
