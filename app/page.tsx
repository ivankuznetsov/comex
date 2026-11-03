import type { Metadata } from 'next';
import ComicGallery from '../components/ComicGallery';

export const metadata: Metadata = {
  alternates: {
    canonical: new URL('/', process.env.COMEX_APP_URL || 'https://comex-seven.vercel.app').href,
  },
};

export default function Home() {
  const mcpUrl = process.env.COMEX_APP_URL ? new URL('/mcp', process.env.COMEX_APP_URL).href : undefined;
  return <ComicGallery mcpUrl={mcpUrl} />;
}
