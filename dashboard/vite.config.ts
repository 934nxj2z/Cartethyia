import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const backendTarget = process.env.VITE_BACKEND_URL ?? "http://127.0.0.1:12800";

/**
 * Dev-server routing for the shared index document: `/` serves the landing app,
 * `/console/*` the admin console, and `/share/*` the public share app. The
 * production server implements the same mapping in
 * `src/console/dashboard-assets.ts`.
 */
function multiPageRouting(): Plugin {
  return {
    name: "cartethyia-multi-page-routing",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const pathname = req.url?.split("?")[0] ?? "";
        if (pathname === "/console" || pathname.startsWith("/console/")) {
          // The console API namespace is proxied to the gateway, not the SPA.
          if (!pathname.startsWith("/console/api")) req.url = "/index.html";
        }
        next();
      });
    },
  };
}

/**
 * Emits a `.gz` sibling beside every built text asset.
 *
 * Compression is paid once per deploy instead of once per request: the
 * dashboard's bundles are static and hashed, so the gzip output for a given
 * build never changes, while compressing at serve time would repeat that work
 * for every visitor of every file.
 *
 * Level 9 — the cost is build time, not request latency, and these bytes are
 * served from disk for the lifetime of the deployment. `src/console/
 * dashboard-assets.ts` serves the `.gz` when the client offered gzip and falls
 * back to the plain file when it did not, so a build without this plugin still
 * works.
 */
function precompressAssets(): Plugin {
  const COMPRESSED_EXTENSIONS = [".js", ".mjs", ".css", ".html", ".json", ".svg"];
  return {
    name: "cartethyia-precompress-assets",
    apply: "build",
    async closeBundle() {
      const { gzipSync } = await import("node:zlib");
      const { readdir, readFile, writeFile } = await import("node:fs/promises");
      const { join, extname, resolve } = await import("node:path");

      // `process.cwd()`, not `import.meta.dir`: Vite transpiles this config to
      // a temp file before running it, so `import.meta.dir` is the temp
      // directory rather than `dashboard/`. The build is invoked from
      // `dashboard/`, and `build.outDir` above is relative to it.
      const root = resolve(process.cwd(), "..", "dist", "dashboard");
      const stack: string[] = [root];
      const written: string[] = [];
      while (stack.length > 0) {
        const dir = stack.pop();
        if (dir === undefined) continue;
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          const full = join(dir, entry.name);
          if (entry.isDirectory()) {
            stack.push(full);
            continue;
          }
          // A `.gz` from an earlier build is not an input.
          if (!COMPRESSED_EXTENSIONS.includes(extname(entry.name).toLowerCase())) continue;
          const source = await readFile(full).catch(() => undefined);
          if (source === undefined) continue;
          await writeFile(`${full}.gz`, gzipSync(source, { level: 9 })).catch(() => undefined);
          written.push(full.slice(root.length + 1));
        }
      }
      // The manifest is what makes the output inspectable: a deploy can assert
      // the `.gz` siblings exist instead of trusting that the plugin ran.
      await writeFile(
        join(root, "precompressed-assets.json"),
        `${JSON.stringify({ count: written.length, assets: written.sort() }, null, 2)}\n`,
      ).catch(() => undefined);
    },
  };
}


export default defineConfig({
  base: "/",
  appType: "spa",
  plugins: [multiPageRouting(), react(), tailwindcss(), precompressAssets()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/console/api": {
        target: backendTarget,
        changeOrigin: false,
      },
      "/v1": {
        target: backendTarget,
        changeOrigin: false,
      },
      "/health": {
        target: backendTarget,
        changeOrigin: false,
      },
      "/metrics": {
        target: backendTarget,
        changeOrigin: false,
      },
      // Share API routes are proxied; public page deep links use index.html.
      "/share": {
        target: backendTarget,
        changeOrigin: false,
        bypass: (req) => {
          const path = (req.url ?? "").split("?")[0] ?? "";
          if (path.endsWith("/data") || path.endsWith("/issue") || path.endsWith("/stats") || path.endsWith("/stream") || path.endsWith("/popup-image")) return undefined;
          return "/index.html";
        },
      },
    },
  },
  build: {
    outDir: "../dist/dashboard",
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    cssCodeSplit: true,
    reportCompressedSize: false,
    rollupOptions: {
      input: {
        index: "index.html",
      },
    },
  },
});
