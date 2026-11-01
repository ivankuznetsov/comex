import ComicGallery from '../components/ComicGallery';
export default function Home() {
  const mcpUrl = process.env.COMEX_APP_URL ? new URL('/mcp', process.env.COMEX_APP_URL).href : undefined;
  return <ComicGallery mcpUrl={mcpUrl} />;
}
