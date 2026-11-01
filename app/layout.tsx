import type { Metadata } from 'next';
import '@fontsource/bangers/latin-400.css';
import './globals.css';

export const metadata: Metadata = {
  title: 'Comex — Make your own comic',
  description: 'Create and share original comics, one panel at a time.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
