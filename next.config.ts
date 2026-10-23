import type { NextConfig } from "next";

/**
 * `output: "standalone"`: `next build` also writes .next/standalone — the server and only the node_modules it needs —
 * which the production Docker image runs (Dockerfile, docs/canliya-alma.md). `next dev` and `next start` are unchanged.
 */
const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
};

export default nextConfig;
