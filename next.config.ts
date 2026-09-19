import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  // pg resolves optional drivers dynamically; keep it external so the
  // standalone output traces real node_modules instead of bundling it.
  serverExternalPackages: ["pg"],
  images: {
    remotePatterns: [
      { protocol: "http", hostname: "**" },
      { protocol: "https", hostname: "**" }
    ]
  }
};

export default nextConfig;
