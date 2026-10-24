import type { MetadataRoute } from 'next';
// Lets drivers and messengers "Add to Home Screen": the app then opens full-screen like a normal phone app.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Reliance Freight — Transport',
    short_name: 'RFS Transport',
    description: 'Jobs and document runs for Reliance Freight Systems drivers and messengers',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#1f2226',
    theme_color: '#1f2226',
    icons: [
      { src: '/app-icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/app-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/app-icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
