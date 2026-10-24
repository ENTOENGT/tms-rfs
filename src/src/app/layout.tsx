import './globals.css';
export const metadata = { title: 'Reliance Freight Systems — Transport Management', description: 'Internal transport management system' };
export default function Root({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
