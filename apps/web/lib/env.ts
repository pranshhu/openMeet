// NEXT_PUBLIC_API_BASE points at the Worker origin, e.g. http://localhost:8787
// In production: https://<your-worker>.<your-subdomain>.workers.dev
const RAW = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:8787';

export const API_BASE = RAW.replace(/\/$/, '');

export const WS_BASE = API_BASE.replace(/^http/, 'ws');
