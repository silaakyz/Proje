import type { NextConfig } from "next";

/**
 * `output: "standalone"`: `next build` also writes .next/standalone — the server and only the node_modules it needs —
 * which the production Docker image runs (Dockerfile, docs/canliya-alma.md). `next dev` and `next start` are unchanged.
 */
const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  // pdfkit reads its own data files at run time: keep it out of the bundle (standalone copies it to node_modules)
  serverExternalPackages: ["pdfkit"],
  // the PDF report's fonts are read from disk (src/server/reports/event-report.ts)
  outputFileTracingIncludes: { "/api/events/[eventId]/report": ["./src/server/reports/fonts/*.ttf"] },
};

export default nextConfig;
