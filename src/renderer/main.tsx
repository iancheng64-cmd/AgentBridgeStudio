import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
// Order matters: styles.css is the base layer, tokens.css is the design system
// and must be able to win over it.
import "./styles.css";
import "./tokens.css";
import "@xterm/xterm/css/xterm.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
