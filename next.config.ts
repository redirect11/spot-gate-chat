import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";
const repoName = "spot-gate-chat";

const nextConfig: NextConfig = {
  output: "export",
  basePath: isProd ? `/${repoName}` : "",
  assetPrefix: isProd ? `/${repoName}/` : "",
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
