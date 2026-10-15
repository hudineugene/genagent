import type { NextConfig } from "next";

// Сборка для сервера (deploy/upload.ps1): автономная папка в .next-deploy, не мешает локальной .next.
const forServer = process.env.BUILD_STANDALONE === "1";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  ...(forServer ? { output: "standalone" as const, distDir: ".next-deploy" } : {}),
  experimental: {
    serverActions: {
      // Админка на сервере открывается через Tailscale (свой адрес и порт) — разрешаем его для форм.
      allowedOrigins: (process.env.ALLOWED_ACTION_ORIGINS ?? "").split(",").filter(Boolean),
    },
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
