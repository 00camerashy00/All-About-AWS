/** @type {import('next').NextConfig} */
const nextConfig = {
  // The local network path mangles streamed gzip responses (truncated
  // pages in real browsers), so serve identity-encoded HTML instead.
  compress: false,
  // Emits .next/standalone for the production image. `next start` still works locally.
  output: "standalone",
};

module.exports = nextConfig;
