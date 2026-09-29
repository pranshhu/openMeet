// Static export needs at least one param to emit a shell for the dynamic route.
// The client reads the real slug from the URL at runtime; this placeholder is
// only a build-time shell. Cloudflare Pages serves it for any /r/* path via the
// catch-all rewrite in public/_redirects.
export function generateStaticParams() {
  return [{ slug: 'placeholder' }];
}

export default function SlugLayout({ children }: { children: React.ReactNode }) {
  return children;
}
