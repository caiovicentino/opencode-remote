import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./index.css";

// No StrictMode: its double-mount in dev races getUserMedia on iOS
// (camera stop/start aborts with AbortError).
createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
);

if (
  "serviceWorker" in navigator &&
  import.meta.env.PROD &&
  location.protocol !== "file:"
) {
  navigator.serviceWorker.register("/sw.js");
}
