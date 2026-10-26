/** @type {import('next').NextConfig} */
export default {
  reactStrictMode: true,
  poweredByHeader: false,
  experimental: { serverComponentsExternalPackages: ['pg', 'bcryptjs', 'exceljs'] },
  // pdf.js (used to show and print PDFs in the browser) has an optional Node-only 'canvas' add-on we never use.
  webpack: (config) => { config.resolve.alias = { ...config.resolve.alias, canvas: false }; return config; },
  async headers() {
    return [{ source: '/(.*)', headers: [
      { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'same-origin' },
    ] }];
  },
};
