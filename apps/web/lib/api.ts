import { API_BASE } from './env';

export interface CreateRoomResult {
  slug: string;
  host_token: string;
  expires_at: number;
}

export interface RoomMeta {
  slug: string;
  expires_at: number;
  consumed: number;
}

export interface TurnCred {
  urls: string[];
  username: string;
  credential: string;
  ttl: number;
}

export async function createRoom(): Promise<CreateRoomResult> {
  const res = await fetch(`${API_BASE}/api/rooms`, {
    method: 'POST',
    credentials: 'include',
  });
  if (res.status !== 201) {
    throw new Error(`createRoom failed: ${res.status}`);
  }
  return (await res.json()) as CreateRoomResult;
}

export interface Sponsor {
  name: string;
  url: string | null;
  logo: string | null;
  weight: number;
}

export interface SponsorsResponse {
  checkoutUrl: string | null;
  sponsors: Sponsor[];
  available: number;
}

export async function getSponsors(): Promise<SponsorsResponse> {
  const res = await fetch(`${API_BASE}/api/sponsors`);
  if (!res.ok) {
    throw new Error(`getSponsors failed: ${res.status}`);
  }
  return (await res.json()) as SponsorsResponse;
}

export async function getRoom(slug: string): Promise<RoomMeta | null> {
  const res = await fetch(`${API_BASE}/api/rooms/${slug}`, { credentials: 'include' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`getRoom failed: ${res.status}`);
  return (await res.json()) as RoomMeta;
}

export async function patchRecording(
  id: string,
  fields: { total_bytes?: number; last_offset?: number; sha256?: string; status?: string },
  hostToken?: string
): Promise<void> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  // Cross-origin deploys can't send the cookie; present the host_token as a bearer.
  if (hostToken) headers.Authorization = `Bearer ${hostToken}`;
  const res = await fetch(`${API_BASE}/api/recordings/${id}`, {
    method: 'PATCH',
    credentials: 'include',
    headers,
    body: JSON.stringify(fields),
  });
  if (!res.ok) throw new Error(`patchRecording failed: ${res.status}`);
}

export async function getTurnCred(slug: string): Promise<TurnCred> {
  const res = await fetch(`${API_BASE}/api/turn-cred`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug }),
  });
  if (!res.ok) throw new Error(`getTurnCred failed: ${res.status}`);
  return (await res.json()) as TurnCred;
}
