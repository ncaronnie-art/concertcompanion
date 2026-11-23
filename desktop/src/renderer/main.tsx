import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installBrowserBridge } from "./browser-bridge";
import { PhoneEntry } from "./PhoneEntry";
import "./style.css";

const phoneMode = !window.concertCompass;
if (phoneMode) installBrowserBridge();
createRoot(document.getElementById("root")!).render(<StrictMode>{phoneMode ? <PhoneEntry /> : <App />}</StrictMode>);
