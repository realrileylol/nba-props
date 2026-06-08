/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    // This explicitly tells Next.js to ignore all TypeScript errors during builds
    ignoreBuildErrors: true,
  },
  eslint: {
    // This tells Next.js to ignore linting warnings during builds
    ignoreDuringBuilds: true,
  },
};

module.exports = nextConfig;
