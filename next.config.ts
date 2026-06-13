import type { NextConfig } from "next";

const repoName = "spot-gate-chat";

// The basePath is ONLY needed on GitHub Pages, where the app is served under
// /<repoName>. Vercel and Firebase Hosting serve it at the root, so basePath
// must stay empty there (otherwise "/" 404s). Opt in explicitly via
// DEPLOY_TARGET=github-pages (set by the GitHub Pages workflow).
const useBasePath = process.env.DEPLOY_TARGET === "github-pages";

const nextConfig: NextConfig = {
  output: "export",
  basePath: useBasePath ? `/${repoName}` : "",
  assetPrefix: useBasePath ? `/${repoName}/` : "",
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
