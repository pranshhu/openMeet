import type { Context } from 'hono';
import type { Env } from '../env.js';

interface PolarOrder {
  id?: string;
  status?: string;
  net_amount?: number;
  refunded_amount?: number;
  refunded_tax_amount?: number;
  customer_id?: string;
  customer?: {
    id?: string;
    email?: string;
    metadata?: Record<string, unknown>;
  };
  created_at?: string;
  custom_field_data?: {
    sponsor_name?: string;
    sponsor_website?: string;
    sponsor_logo_url?: string;
  };
}

interface PolarOrdersResponse {
  items?: PolarOrder[];
  pagination?: {
    max_page?: number;
    total_count?: number;
  };
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

function parseHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' ? trimmed : null;
  } catch {
    return null;
  }
}

export async function getSponsors(c: Context<{ Bindings: Env }>): Promise<Response> {
  const token = c.env.POLAR_ACCESS_TOKEN?.trim();
  const productId = c.env.POLAR_PRODUCT_ID?.trim();
  const checkoutUrl = c.env.SPONSOR_CHECKOUT_URL?.trim();

  // If token, product id or checkout URL is missing, wall is unconfigured.
  if (!token || !productId || !checkoutUrl) {
    const unconfigured: SponsorsResponse = {
      checkoutUrl: null,
      sponsors: [],
      available: 1,
    };
    return c.json(unconfigured, 200);
  }

  // Keyed by request URL without query string.
  const reqUrl = new URL(c.req.url);
  reqUrl.search = '';
  const cacheKey = new Request(reqUrl.toString(), { method: 'GET' });
  const cache = typeof caches !== 'undefined' ? caches.default : null;

  if (cache) {
    try {
      const cached = await cache.match(cacheKey);
      if (cached) {
        return new Response(cached.body, {
          status: cached.status,
          headers: new Headers(cached.headers),
        });
      }
    } catch {
      // Ignore cache match failure and proceed.
    }
  }

  try {
    const apiBase = c.env.POLAR_API_BASE?.trim()
      ? c.env.POLAR_API_BASE.trim().replace(/\/+$/, '')
      : 'https://api.polar.sh';

    let page = 1;
    let maxPage = 1;
    const allOrders: PolarOrder[] = [];

    // Follow pagination up to max_page.
    // Known limit: 45 pages x 100 orders stays under the free plan's 50 subrequests per
    // invocation; past ~4,500 orders the oldest are ignored, move to a webhook + D1 then.
    while (page <= Math.min(maxPage, 45)) {
      const url = `${apiBase}/v1/orders/?product_id=${encodeURIComponent(productId)}&limit=100&page=${page}`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!res.ok) {
        throw new Error(`polar_status_${res.status}`);
      }

      const data = (await res.json()) as PolarOrdersResponse;
      if (!data || !Array.isArray(data.items)) {
        throw new Error('polar_invalid_json');
      }

      allOrders.push(...data.items);
      maxPage = typeof data.pagination?.max_page === 'number' ? data.pagination.max_page : 1;
      page++;
    }

    // Sort orders descending by created_at so most recent orders come first.
    allOrders.sort((a, b) => {
      const da = a.created_at ? Date.parse(a.created_at) || 0 : 0;
      const db = b.created_at ? Date.parse(b.created_at) || 0 : 0;
      return db - da;
    });

    interface CustomerAgg {
      totalCents: number;
      approved: boolean;
      orderWithName?: PolarOrder;
    }

    const customers = new Map<string, CustomerAgg>();

    for (const order of allOrders) {
      const customerId = order.customer_id ?? order.customer?.id;
      if (!customerId) continue;

      let agg = customers.get(customerId);
      if (!agg) {
        agg = { totalCents: 0, approved: false };
        customers.set(customerId, agg);
      }

      // Check approval flag in customer metadata (boolean or string "true").
      const approvedVal = order.customer?.metadata?.sponsor_approved;
      if (approvedVal === true || approvedVal === 'true') {
        agg.approved = true;
      }

      // Track the customer's most recent order that has custom_field_data.sponsor_name.
      if (!agg.orderWithName && order.custom_field_data?.sponsor_name != null) {
        agg.orderWithName = order;
      }

      // Contribution from paid or partially_refunded orders.
      if (order.status === 'paid' || order.status === 'partially_refunded') {
        const net = typeof order.net_amount === 'number' ? order.net_amount : 0;
        const ref = typeof order.refunded_amount === 'number' ? order.refunded_amount : 0;
        const refTax = typeof order.refunded_tax_amount === 'number' ? order.refunded_tax_amount : 0;
        const contribution = Math.max(0, net - (ref - refTax));
        agg.totalCents += contribution;
      }
    }

    interface QualifiedSponsor {
      name: string;
      url: string | null;
      logo: string | null;
      totalCents: number;
    }

    const qualified: QualifiedSponsor[] = [];

    for (const agg of customers.values()) {
      // Only approved customers with total >= 2500 cents ($25).
      if (!agg.approved || agg.totalCents < 2500) continue;

      const rawName = agg.orderWithName?.custom_field_data?.sponsor_name;
      const name = typeof rawName === 'string' ? rawName.trim().slice(0, 60) : '';
      // Name required: skip the customer if empty.
      if (!name) continue;

      const url = parseHttpsUrl(agg.orderWithName?.custom_field_data?.sponsor_website);
      const logo = parseHttpsUrl(agg.orderWithName?.custom_field_data?.sponsor_logo_url);

      qualified.push({
        name,
        url,
        logo,
        totalCents: agg.totalCents,
      });
    }

    const sumOfShownTotals = qualified.reduce((acc, s) => acc + s.totalCents, 0);
    // Capacity = max(sumOfShownTotals * 1.25, 100_000 cents)
    const capacity = Math.max(sumOfShownTotals * 1.25, 100_000);

    const sponsors: Sponsor[] = qualified.map((s) => ({
      name: s.name,
      url: s.url,
      logo: s.logo,
      weight: s.totalCents / capacity,
    }));

    // Sponsors sorted by weight, descending.
    sponsors.sort((a, b) => b.weight - a.weight);

    const sumWeights = sponsors.reduce((acc, s) => acc + s.weight, 0);
    const available = Math.max(0, Math.round((1 - sumWeights) * 1e6) / 1e6);

    const responseBody: SponsorsResponse = {
      checkoutUrl,
      sponsors,
      available,
    };

    const res = new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=600',
      },
    });

    if (cache) {
      try {
        await cache.put(cacheKey, res.clone());
      } catch {
        // Ignore cache storage errors.
      }
    }

    return res;
  } catch {
    // Polar failed (network, non-2xx, bad JSON): degrade gracefully, never 5xx.
    console.error('sponsors:polar_fetch_failed');
    const fallbackBody: SponsorsResponse = {
      checkoutUrl,
      sponsors: [],
      available: 1,
    };

    const fallbackRes = new Response(JSON.stringify(fallbackBody), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60',
      },
    });

    if (cache) {
      try {
        await cache.put(cacheKey, fallbackRes.clone());
      } catch {
        // Ignore cache storage errors.
      }
    }

    return fallbackRes;
  }
}
