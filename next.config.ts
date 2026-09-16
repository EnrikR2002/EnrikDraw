import path from "node:path";
import type { NextConfig } from "next";

/**
 * Which sites may put this app in an iframe.
 *
 * Notion serves the app itself from notion.so and notion.com, and published
 * pages from notion.site. 'self' keeps our own pages working.
 *
 * Override with the FRAME_ANCESTORS environment variable (a space separated
 * list) if Notion ever serves embeds from another domain. The value is read
 * when the app is built, so change it and then redeploy.
 */
const frameAncestors =
  process.env.FRAME_ANCESTORS ??
  [
    "'self'",
    "https://*.notion.so",
    "https://notion.so",
    "https://*.notion.site",
    "https://notion.site",
    "https://*.notion.com",
    "https://notion.com",
  ].join(" ");

const nextConfig: NextConfig = {
  // Pin the build root to this folder. Without it Turbopack walks up looking
  // for a lock file and can pick the wrong directory.
  turbopack: { root: path.resolve(process.cwd()) },

  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Drawing URLs carry an access token, so never hand that URL to
          // another site in a Referer header.
          { key: "Referrer-Policy", value: "no-referrer" },
          // Note: X-Frame-Options is deliberately not set. It has no syntax
          // for an allow-list, and setting it would block Notion.
          { key: "Content-Security-Policy", value: `frame-ancestors ${frameAncestors};` },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
