import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { PwaNotifications } from "./pwa/PwaNotifications";
import { i18nReady } from "./i18n";
import "./styles.css";

// Wait for the boot language's strings (instant for English; one tiny cached
// chunk for others) so a Russian device never flashes an English first frame.
// i18nReady never rejects — a failed load falls back to English and still renders.
void i18nReady.then(() => {
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <PwaNotifications />
      <App />
    </React.StrictMode>
  );
});
