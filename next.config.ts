import type { NextConfig } from "next";

// Static export deployed to Firebase Hosting (served at the root — no basePath).
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
