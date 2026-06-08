/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export', // <-- THIS IS THE SILVER BULLET
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};

module.exports = nextConfig;
