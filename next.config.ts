import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Симуляционный движок и БД живут как singleton в globalThis,
  // чтобы переживать HMR в dev-режиме.
  experimental: {},
  // Портативная сборка для «любого ПК»: .next/standalone/server.js
  // запускается без npm install (scripts/make-release.mjs собирает release/).
  output: "standalone",
};

export default nextConfig;
