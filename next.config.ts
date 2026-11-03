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
  // pdfjs-dist (server-side only; the client never imports it) is BUNDLED
  // into the server chunks rather than externalized, and the tax-parse
  // loader imports the worker module itself (pdf.js's globalThis.pdfjsWorker
  // hook) so no runtime import of the sibling pdf.worker.mjs ever runs:
  //   - Bundled into a Turbopack chunk, that module-relative worker import
  //     pointed at .next/dev/server/chunks/ and failed — every 1040 upload
  //     surfaced as honestly "unreadable" instead of parsed (the
  //     income-capture round-1 live failure).
  //   - Externalized (the interim fix), the engine loaded from
  //     node_modules locally but the deployed lambda's packaging dropped
  //     Turbopack's external-copy tree — the engine module load itself
  //     failed in production (the VAL-SPRINT-004 prod-parity 500).
  // Bundled + worker hook removes both failure paths: no node_modules path
  // and no copied external tree needs to exist at runtime.
};

export default nextConfig;
