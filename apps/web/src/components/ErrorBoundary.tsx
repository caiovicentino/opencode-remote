import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Last line of defense: a render crash should never brick the PWA silently. */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error(JSON.stringify({
      ts: new Date().toISOString(),
      level: "error",
      msg: "react render crash",
      error: error.message,
      componentStack: info.componentStack?.slice(0, 500),
    }));
  }

  render() {
    if (this.state.error) {
      return (
        <div className="screen">
          <h1 style={{ fontSize: "1rem" }}>Something broke</h1>
          <p style={{ color: "var(--danger)" }}>{this.state.error.message}</p>
          <button className="primary" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
