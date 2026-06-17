import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { PwaNotifications } from "./pwa/PwaNotifications";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <PwaNotifications />
    <App />
  </React.StrictMode>
);
