/**
 * The console's entry point.
 *
 * A placeholder: the router, the API client and the layout arrive with the
 * foundational phase, which replaces this with the real shell.
 *
 * Author: John Grimes
 */

import { createRoot } from "react-dom/client";

import { App } from "./App.js";

const root = document.querySelector("#root");
if (root === null) {
  throw new Error("The document has no #root element to mount into");
}

createRoot(root).render(<App />);
