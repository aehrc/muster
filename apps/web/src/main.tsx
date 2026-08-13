/**
 * The console's entry point.
 *
 * Author: John Grimes
 */

import { createRoot } from "react-dom/client";

import { App } from "./App.js";

import "./styles.css";

const root = document.querySelector("#root");
if (root === null) {
  throw new Error("The document has no #root element to mount into");
}

createRoot(root).render(<App />);
