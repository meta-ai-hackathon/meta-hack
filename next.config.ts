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
};

export default nextConfig;
