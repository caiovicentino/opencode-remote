import { Component, type ReactNode } from "react";
import { getLang, translate } from "../lib/i18n";

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
      // eval-10: localized, and the raw message (e.g. "Minified React error
      // #31; visit https://…") moves behind a details fold — it is a
      // diagnostic, not copy for the person holding the phone
      const lang = getLang();
      return (
        <div className="screen">
          <h1 style={{ fontSize: "1rem" }}>{translate(lang, "crashTitle")}</h1>
          <p>{translate(lang, "crashBody")}</p>
          <button className="primary" onClick={() => this.setState({ error: null })}>
            {translate(lang, "crashRetry")}
          </button>
          <details className="muted" style={{ fontSize: "0.75rem" }}>
            <summary>{translate(lang, "crashDetails")}</summary>
            <p style={{ overflowWrap: "anywhere" }}>{this.state.error.message}</p>
          </details>
        </div>
      );
    }
    return this.props.children;
  }
}
