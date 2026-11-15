import type { NextConfig } from "next";

const apiUrl = process.env.BACKEND_URL ?? "http://127.0.0.1:8000";

const config: NextConfig = {
  devIndicators: false,
  outputFileTracingRoot: process.cwd(),
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${apiUrl}/api/:path*` }];
  },
};

export default config;
