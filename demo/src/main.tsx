/**
 * This file is the entry point for the React app, it sets up the root
 * element and renders the App component to the DOM.
 *
 * It is included in `index.html`.
 */

import { createRoot } from "react-dom/client";
import { App } from "./App";

const elem = document.getElementById("root")!;
// No StrictMode: its dev-only mount/unmount/remount left @react-three/rapier
// with a second, stale rigid body per balloon, frozen at the spawn point. Our
// forces went to one body and the scene showed the other, and popping a
// letter snapped it back to its spawn point.
const app = <App />;

if (import.meta.hot) {
  // With hot module reloading, `import.meta.hot.data` is persisted.
  const root = (import.meta.hot.data.root ??= createRoot(elem));
  root.render(app);
} else {
  // The hot module reloading API is not available in production.
  createRoot(elem).render(app);
}
