import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const activeDistDir = process.env.CODEX_SLIDES_DIST_DIR
  || (process.env.NODE_ENV === "development" ? ".next-dev" : ".next");

// Exclude every other .next* build directory from output file tracing, but
// never the active one: the standalone server's own webpack-runtime.js and
// chunks live inside it, and excluding them ships a server that cannot load
// any route (a bug that only appears in packaged desktop builds).
const staleBuildDirExcludes = readdirSync(new URL(".", import.meta.url), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith(".next") && entry.name !== activeDistDir)
  .map((entry) => `./${entry.name}/**/*`);

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Local and packaged builds serve project/community imagery directly. This
  // avoids a platform-specific sharp binary in the Electron runtime.
  images: { unoptimized: true },
  // Electron packages the traced Node server plus static/public assets. The
  // same build remains deployable as the normal web application.
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL(".", import.meta.url)),
  // Keep a live dev server isolated from `next build`. Both commands default to
  // `.next`; running a production build while dev is open otherwise overwrites
  // the dev route manifests and leaves the live server returning Next's 404.
  distDir: activeDistDir,
  typescript: {
    // The development runner isolates build output by port and supplies an
    // ignored per-port config so concurrent Web/Desktop sessions never rewrite
    // the checked-in tsconfig.json.
    tsconfigPath: process.env.CODEX_SLIDES_TSCONFIG_PATH || "tsconfig.json",
  },
  // The app spawns local agent CLIs and reads ~/.codex/auth.json on the server.
  // pptxgenjs / pdf-lib pull in Node built-ins; keep them external to the bundle.
  serverExternalPackages: ["pptxgenjs", "pdf-lib"],
  // Next 15 startup requires this module before route handlers are loaded.
  outputFileTracingIncludes: {
    "/*": ["./node_modules/next/dist/server/lib/cpu-profile.js"],
  },
    // Never trace local user content or transient developer state into a
    // distributable standalone server. Desktop builds create their own empty
    // data root under Electron's appData directory at runtime.
  outputFileTracingExcludes: {
      "*": [
        "./data/**/*",
        "./dist/**/*",
        ...staleBuildDirExcludes,
        "./.pnpm-store/**/*",
        "./.claude/**/*",
        "./.claude-sessions/**/*",
        "./.qa/**/*",
        "./.tmp/**/*",
        "./tmp/**/*",
      ],
  },
};

export default nextConfig;
