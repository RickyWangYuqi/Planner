import React from "react";
import ReactDOM from "react-dom/client";
import { AppProvider } from "./store";
import { Shell } from "./components/Shell";
import "./styles/themes.css";
import "./styles/app.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AppProvider>
      <Shell />
    </AppProvider>
  </React.StrictMode>
);
