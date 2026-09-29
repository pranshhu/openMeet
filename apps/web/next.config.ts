import type { NextConfig } from 'next';

// NEXT_PUBLIC_API_BASE is INLINED into the bundle at build time, so a
// production build that forgets it ships a site pointing at localhost:8787.
// Every symptom of that is silent — the deploy succeeds, every asset 200s, the
// page renders — and the only evidence is ERR_CONNECTION_REFUSED in a browser
// console. Fail the build instead.
if (process.env.NODE_ENV === 'production' && !process.env.NEXT_PUBLIC_API_BASE) {
  throw new Error(
    'NEXT_PUBLIC_API_BASE is required for a production build — it is baked into the ' +
      'bundle, and without it the deployed site calls http://localhost:8787.\n' +
      '  NEXT_PUBLIC_API_BASE=https://<your-worker>.workers.dev pnpm build\n' +
      'Set it explicitly to http://localhost:8787 if you really are exporting for local use.'
  );
}

const nextConfig: NextConfig = {
  // Static export (Cloudflare Pages target) only for production builds. In dev,
  // `output: 'export'` forces every /r/[slug] to be pre-listed in
  // generateStaticParams, which 500s for real slugs. The room page reads its
  // slug at runtime client-side, so dev runs without export and renders any slug.
  ...(process.env.NODE_ENV === 'production' ? { output: 'export' as const } : {}),
  images: { unoptimized: true },
  trailingSlash: true,
  // Next 16 rejects dev requests whose Origin isn't listed here, which breaks
  // the HMR socket and leaves the page blank when you open the dev server from
  // another machine on the LAN (e.g. testing host + guest on two laptops).
  // Private ranges only, and dev-only by nature — `next dev` is the only thing
  // that reads this.
  allowedDevOrigins: ['192.168.*.*', '10.*.*.*', '172.16.*.*', '172.17.*.*', '172.18.*.*'],
};

export default nextConfig;
