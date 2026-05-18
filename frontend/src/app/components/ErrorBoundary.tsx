import React from 'react';
import { report, getRecentActions } from '@/shared/serviceClient';

interface Props {
  /** Title for the fallback card. */
  title?: string;
  /** If provided, Reload calls this instead of reloading the window. */
  onReset?: () => void;
  /** Where the boundary lives, for support ("root", "page:tools", etc.). */
  scope?: string;
  children: React.ReactNode;
}

interface State {
  error: Error | null;
}

/** Catches uncaught render errors; fallback shows stack, cloud gets a fire-and-forget report. */
class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    try {
      report('app', 'error_boundary', {
        scope: this.props.scope || 'unknown',
        message: String(error?.message || error).slice(0, 500),
        stack: String(error?.stack || '').slice(0, 2000),
        component_stack: String(info?.componentStack || '').slice(0, 2000),
        recent_actions: getRecentActions(10),
      });
    } catch {}
    if (typeof console !== 'undefined' && console.error) {
      console.error('[ErrorBoundary]', error, info);
    }
  }

  handleReload = () => {
    if (this.props.onReset) {
      this.props.onReset();
      this.setState({ error: null });
      return;
    }
    try { window.location.reload(); } catch {}
  };

  handleResetState = () => {
    try {
      const keys = Object.keys(localStorage);
      for (const k of keys) {
        if (k.startsWith('openswarm:') || k.startsWith('redux-')) {
          localStorage.removeItem(k);
        }
      }
    } catch {}
    try { window.location.reload(); } catch {}
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const title = this.props.title || 'Something broke.';
    const wrap: React.CSSProperties = {
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 32,
      fontFamily: '-apple-system, BlinkMacSystemFont, sans-serif',
      background: '#0e0f12',
      color: '#dad8d2',
    };
    const card: React.CSSProperties = {
      maxWidth: 640,
      background: '#16181d',
      border: '1px solid rgba(255,255,255,0.08)',
      borderRadius: 12,
      padding: 24,
      boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
    };
    const btn: React.CSSProperties = {
      background: '#c4633a',
      color: 'white',
      border: 'none',
      borderRadius: 6,
      padding: '8px 14px',
      fontSize: 13,
      fontWeight: 600,
      cursor: 'pointer',
      marginRight: 8,
    };
    const btnSecondary: React.CSSProperties = {
      ...btn,
      background: 'transparent',
      border: '1px solid rgba(255,255,255,0.15)',
      color: '#dad8d2',
    };
    const stack: React.CSSProperties = {
      marginTop: 16,
      fontFamily: 'ui-monospace, SFMono-Regular, monospace',
      fontSize: 11,
      lineHeight: 1.5,
      background: '#0a0b0d',
      padding: 12,
      borderRadius: 6,
      maxHeight: 200,
      overflow: 'auto',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-all',
      color: '#9c9a92',
    };

    return (
      <div style={wrap} role="alert" aria-live="assertive">
        <div style={card}>
          <h2 style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 600 }}>{title}</h2>
          <p style={{ margin: '0 0 16px', color: '#9c9a92', fontSize: 14, lineHeight: 1.5 }}>
            We caught it before it crashed everything. The error is below; copy it
            if you want to share. Reload usually fixes it.
          </p>
          <div>
            <button type="button" style={btn} onClick={this.handleReload}>Reload</button>
            <button type="button" style={btnSecondary} onClick={this.handleResetState}>Reset & reload</button>
          </div>
          <pre style={stack}>{String(error?.stack || error?.message || error)}</pre>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
