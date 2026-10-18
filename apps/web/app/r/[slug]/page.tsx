'use client';

import { useEffect, useState } from 'react';
import { RoomView } from '@/components/RoomView';
import NotFound from '@/app/not-found';

// Static export serves the /r/placeholder shell for every /r/<slug> path (see
// public/_redirects), so the build-time `params` slug is always "placeholder".
// Read the real slug from the address bar at runtime instead. Slugs are
// lowercase, so a link typed with capitals reaches the same room.
function slugFromPath(): string | null {
  const m = window.location.pathname.match(/\/r\/([^/]+)/);
  return m && m[1] ? decodeURIComponent(m[1]).toLowerCase() : null;
}

export default function RoomPage() {
  // undefined: not read yet. null: the address has no slug (e.g. /r/).
  const [slug, setSlug] = useState<string | null>();
  useEffect(() => {
    setSlug(slugFromPath());
  }, []);
  if (slug === undefined) return null;
  if (slug === null) return <NotFound />;
  return <RoomView slug={slug} />;
}
