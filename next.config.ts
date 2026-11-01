import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  async rewrites() {
    const backend = process.env.COMEX_DEMO_BACKEND_URL;
    if (!backend) return {beforeFiles: [], afterFiles: [], fallback: []};
    const url = new URL(backend);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('COMEX_DEMO_BACKEND_URL must be an HTTPS origin without credentials or a path.');
    }
    return {
      beforeFiles: [{source: '/api/:path*', destination: `${url.origin}/api/:path*`}],
      afterFiles: [], fallback: [],
    };
  },
};
export default nextConfig;
