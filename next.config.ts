import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // The forms fill route reads the committed sample-form templates from the
  // registry at request time (server-side fixture data, no person data);
  // include them in the traced output so production downloads work too.
  outputFileTracingIncludes: {
    "/api/forms/**": ["./src/lib/forms/fixtures/**"],
  },
  // pdf.js's fake-worker setup (Node has no DOM worker) imports its
  // sibling pdf.worker.mjs at runtime with a module-relative path.
  // Bundled into a Turbopack server chunk, that import resolved against
  // .next/dev/server/chunks/ and failed — every 1040 upload then surfaced
  // as honestly "unreadable" instead of parsed (the income-capture
  // round-1 live failure). Keep pdfjs-dist a real Node module (it is
  // server-side only; the client never imports it) so the worker resolves
  // from node_modules.
  serverExternalPackages: ["pdfjs-dist"],
};

export default nextConfig;
