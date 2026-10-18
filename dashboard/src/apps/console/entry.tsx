import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "../../App";
import { restorePersistedCache, startPersisting } from "../../data/query-client";
import "../../styles/base.css";
import "../../styles/app.css";

/**
 * Mounts the authenticated console app into the shared dashboard document.
 *
 * The persisted catalog is restored *before* render, not in an effect: the
 * point is that the first paint has data to draw, and an effect runs after the
 * first paint. The restore is a single IndexedDB read of one record, and a
 * miss or a failure is a normal cold start — so nothing waits on the network
 * here and nothing can block the mount.
 */
export function mountConsole(root: HTMLElement): void {
  document.title = "Cartethyia Console";
  void restorePersistedCache().finally(() => {
    startPersisting();
    createRoot(root).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });
}
