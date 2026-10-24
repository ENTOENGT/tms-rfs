import './globals.css';
import type { Metadata, Viewport } from 'next';
export const metadata: Metadata = {
  title: 'Reliance Freight Systems — Transport Management',
  description: 'Internal transport management system',
  appleWebApp: { capable: true, title: 'RFS Transport', statusBarStyle: 'black-translucent' },
};
export const viewport: Viewport = { themeColor: '#1f2226', width: 'device-width', initialScale: 1 };
export default function Root({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
