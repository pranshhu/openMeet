export function isAllowedOrigin(allowOrigin: string, requestOrigin: string | null): requestOrigin is string {
  return !!requestOrigin && requestOrigin === allowOrigin;
}

export function corsHeaders(allowOrigin: string, requestOrigin: string | null): Record<string, string> {
  if (!isAllowedOrigin(allowOrigin, requestOrigin)) return {};
  return {
    'Access-Control-Allow-Origin': requestOrigin,
    'Access-Control-Allow-Credentials': 'true',
    'Vary': 'Origin',
  };
}

export function handlePreflight(req: Request, allowOrigin: string): Response | null {
  if (req.method !== 'OPTIONS') return null;
  const origin = req.headers.get('Origin');
  const h = corsHeaders(allowOrigin, origin);
  return new Response(null, {
    status: 204,
    headers: {
      ...h,
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, authorization',
      'Access-Control-Max-Age': '86400',
    },
  });
}
