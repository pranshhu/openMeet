import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SELF, env, fetchMock } from 'cloudflare:test';
import app from '../src/index.js';

describe('GET /api/sponsors', () => {
  beforeEach(async () => {
    fetchMock.activate();
    fetchMock.disableNetConnect();
    try {
      await caches.default.delete(new Request('https://test/api/sponsors', { method: 'GET' }));
    } catch {}
  });

  afterEach(() => {
    fetchMock.assertNoPendingInterceptors();
    fetchMock.deactivate();
  });

  it('unconfigured returns checkoutUrl: null', async () => {
    const res = await SELF.fetch('https://test/api/sponsors');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      checkoutUrl: null,
      sponsors: [],
      available: 1,
    });
  });

  it('unconfigured when token, product id, or checkout url is missing', async () => {
    // Missing token
    const resNoToken = await app.fetch(
      new Request('https://test/api/sponsors'),
      {
        ...env,
        POLAR_PRODUCT_ID: 'prod_123',
        SPONSOR_CHECKOUT_URL: 'https://buy.polar.sh/c1',
      }
    );
    expect(await resNoToken.json()).toEqual({ checkoutUrl: null, sponsors: [], available: 1 });

    // Missing product id
    const resNoProd = await app.fetch(
      new Request('https://test/api/sponsors'),
      {
        ...env,
        POLAR_ACCESS_TOKEN: 'token_123',
        SPONSOR_CHECKOUT_URL: 'https://buy.polar.sh/c1',
      }
    );
    expect(await resNoProd.json()).toEqual({ checkoutUrl: null, sponsors: [], available: 1 });

    // Missing checkout url
    const resNoUrl = await app.fetch(
      new Request('https://test/api/sponsors'),
      {
        ...env,
        POLAR_ACCESS_TOKEN: 'token_123',
        POLAR_PRODUCT_ID: 'prod_123',
      }
    );
    expect(await resNoUrl.json()).toEqual({ checkoutUrl: null, sponsors: [], available: 1 });
  });

  it('only approved customers >= $25 appear', async () => {
    const testEnv = {
      ...env,
      POLAR_ACCESS_TOKEN: 'test_token',
      POLAR_PRODUCT_ID: 'prod_123',
      SPONSOR_CHECKOUT_URL: 'https://buy.polar.sh/test',
    };

    fetchMock
      .get('https://api.polar.sh')
      .intercept({
        path: (p) => p.includes('/v1/orders/'),
        method: 'GET',
      })
      .reply(200, {
        items: [
          {
            id: 'ord_1',
            status: 'paid',
            net_amount: 2500,
            customer_id: 'cust_approved_exact',
            customer: {
              id: 'cust_approved_exact',
              metadata: { sponsor_approved: true },
            },
            created_at: '2026-01-01T00:00:00Z',
            custom_field_data: { sponsor_name: 'Exact $25' },
          },
          {
            id: 'ord_2',
            status: 'paid',
            net_amount: 2499,
            customer_id: 'cust_approved_under',
            customer: {
              id: 'cust_approved_under',
              metadata: { sponsor_approved: true },
            },
            created_at: '2026-01-01T00:00:00Z',
            custom_field_data: { sponsor_name: 'Under $25' },
          },
          {
            id: 'ord_3',
            status: 'paid',
            net_amount: 5000,
            customer_id: 'cust_unapproved',
            customer: {
              id: 'cust_unapproved',
              metadata: { sponsor_approved: false },
            },
            created_at: '2026-01-01T00:00:00Z',
            custom_field_data: { sponsor_name: 'Unapproved $50' },
          },
          {
            id: 'ord_4',
            status: 'paid',
            net_amount: 3000,
            customer_id: 'cust_string_true',
            customer: {
              id: 'cust_string_true',
              metadata: { sponsor_approved: 'true' },
            },
            created_at: '2026-01-01T00:00:00Z',
            custom_field_data: { sponsor_name: 'String True $30' },
          },
        ],
        pagination: { max_page: 1 },
      });

    const res = await app.fetch(new Request('https://test/api/sponsors'), testEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.checkoutUrl).toBe('https://buy.polar.sh/test');
    expect(body.sponsors).toHaveLength(2);
    const names = body.sponsors.map((s: any) => s.name);
    expect(names).toContain('Exact $25');
    expect(names).toContain('String True $30');
    expect(names).not.toContain('Under $25');
    expect(names).not.toContain('Unapproved $50');
  });

  it('totals add up across several orders and pages', async () => {
    const testEnv = {
      ...env,
      POLAR_ACCESS_TOKEN: 'test_token',
      POLAR_PRODUCT_ID: 'prod_123',
      SPONSOR_CHECKOUT_URL: 'https://buy.polar.sh/test',
    };

    fetchMock
      .get('https://api.polar.sh')
      .intercept({
        path: (p) => p.includes('page=1'),
        method: 'GET',
      })
      .reply(200, {
        items: [
          {
            id: 'ord_1',
            status: 'paid',
            net_amount: 1500,
            customer_id: 'cust_multi',
            customer: {
              id: 'cust_multi',
              metadata: { sponsor_approved: true },
            },
            created_at: '2026-01-01T00:00:00Z',
            custom_field_data: { sponsor_name: 'Multi Order' },
          },
        ],
        pagination: { max_page: 2 },
      });

    fetchMock
      .get('https://api.polar.sh')
      .intercept({
        path: (p) => p.includes('page=2'),
        method: 'GET',
      })
      .reply(200, {
        items: [
          {
            id: 'ord_2',
            status: 'paid',
            net_amount: 1500,
            customer_id: 'cust_multi',
            customer: {
              id: 'cust_multi',
              metadata: { sponsor_approved: true },
            },
            created_at: '2026-01-02T00:00:00Z',
            custom_field_data: { sponsor_name: 'Multi Order' },
          },
        ],
        pagination: { max_page: 2 },
      });

    const res = await app.fetch(new Request('https://test/api/sponsors'), testEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.sponsors).toHaveLength(1);
    expect(body.sponsors[0].name).toBe('Multi Order');
    // Total is 3000 cents. Under $1000 floor (100,000 cents): weight = 3000 / 100000 = 0.03
    expect(body.sponsors[0].weight).toBeCloseTo(0.03);
  });

  it('refunds subtract', async () => {
    const testEnv = {
      ...env,
      POLAR_ACCESS_TOKEN: 'test_token',
      POLAR_PRODUCT_ID: 'prod_123',
      SPONSOR_CHECKOUT_URL: 'https://buy.polar.sh/test',
    };

    fetchMock
      .get('https://api.polar.sh')
      .intercept({
        path: (p) => p.includes('/v1/orders/'),
        method: 'GET',
      })
      .reply(200, {
        items: [
          {
            id: 'ord_1',
            status: 'partially_refunded',
            net_amount: 5000,
            refunded_amount: 3000,
            refunded_tax_amount: 500,
            customer_id: 'cust_partially_refunded',
            customer: {
              id: 'cust_partially_refunded',
              metadata: { sponsor_approved: true },
            },
            created_at: '2026-01-01T00:00:00Z',
            custom_field_data: { sponsor_name: 'Refunded Net $25' },
          },
          {
            id: 'ord_2',
            status: 'partially_refunded',
            net_amount: 3000,
            refunded_amount: 1000,
            refunded_tax_amount: 0,
            customer_id: 'cust_refunded_below',
            customer: {
              id: 'cust_refunded_below',
              metadata: { sponsor_approved: true },
            },
            created_at: '2026-01-01T00:00:00Z',
            custom_field_data: { sponsor_name: 'Refunded Under' },
          },
        ],
        pagination: { max_page: 1 },
      });

    const res = await app.fetch(new Request('https://test/api/sponsors'), testEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.sponsors).toHaveLength(1);
    expect(body.sponsors[0].name).toBe('Refunded Net $25');
  });

  it('non-https url/logo become null', async () => {
    const testEnv = {
      ...env,
      POLAR_ACCESS_TOKEN: 'test_token',
      POLAR_PRODUCT_ID: 'prod_123',
      SPONSOR_CHECKOUT_URL: 'https://buy.polar.sh/test',
    };

    fetchMock
      .get('https://api.polar.sh')
      .intercept({
        path: (p) => p.includes('/v1/orders/'),
        method: 'GET',
      })
      .reply(200, {
        items: [
          {
            id: 'ord_1',
            status: 'paid',
            net_amount: 5000,
            customer_id: 'cust_urls',
            customer: {
              id: 'cust_urls',
              metadata: { sponsor_approved: true },
            },
            created_at: '2026-01-01T00:00:00Z',
            custom_field_data: {
              sponsor_name: 'URL Tester',
              sponsor_website: 'http://insecure.org',
              sponsor_logo_url: 'ftp://ftp.example.com/logo.svg',
            },
          },
          {
            id: 'ord_2',
            status: 'paid',
            net_amount: 5000,
            customer_id: 'cust_valid_urls',
            customer: {
              id: 'cust_valid_urls',
              metadata: { sponsor_approved: true },
            },
            created_at: '2026-01-01T00:00:00Z',
            custom_field_data: {
              sponsor_name: 'Valid URL Tester',
              sponsor_website: 'https://example.com',
              sponsor_logo_url: 'https://example.com/logo.png',
            },
          },
        ],
        pagination: { max_page: 1 },
      });

    const res = await app.fetch(new Request('https://test/api/sponsors'), testEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const urlTester = body.sponsors.find((s: any) => s.name === 'URL Tester');
    expect(urlTester.url).toBeNull();
    expect(urlTester.logo).toBeNull();

    const validTester = body.sponsors.find((s: any) => s.name === 'Valid URL Tester');
    expect(validTester.url).toBe('https://example.com');
    expect(validTester.logo).toBe('https://example.com/logo.png');
  });

  it('missing name is skipped and name is trimmed to max 60 chars', async () => {
    const testEnv = {
      ...env,
      POLAR_ACCESS_TOKEN: 'test_token',
      POLAR_PRODUCT_ID: 'prod_123',
      SPONSOR_CHECKOUT_URL: 'https://buy.polar.sh/test',
    };

    const longName = 'A'.repeat(80);
    fetchMock
      .get('https://api.polar.sh')
      .intercept({
        path: (p) => p.includes('/v1/orders/'),
        method: 'GET',
      })
      .reply(200, {
        items: [
          {
            id: 'ord_1',
            status: 'paid',
            net_amount: 5000,
            customer_id: 'cust_no_name',
            customer: {
              id: 'cust_no_name',
              metadata: { sponsor_approved: true },
            },
            created_at: '2026-01-01T00:00:00Z',
            custom_field_data: {
              sponsor_name: '   ',
            },
          },
          {
            id: 'ord_2',
            status: 'paid',
            net_amount: 5000,
            customer_id: 'cust_long_name',
            customer: {
              id: 'cust_long_name',
              metadata: { sponsor_approved: true },
            },
            created_at: '2026-01-01T00:00:00Z',
            custom_field_data: {
              sponsor_name: `   ${longName}   `,
            },
          },
        ],
        pagination: { max_page: 1 },
      });

    const res = await app.fetch(new Request('https://test/api/sponsors'), testEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.sponsors).toHaveLength(1);
    expect(body.sponsors[0].name).toBe('A'.repeat(60));
  });

  it('weights + available sum to 1 and available >= 0.2', async () => {
    const testEnv = {
      ...env,
      POLAR_ACCESS_TOKEN: 'test_token',
      POLAR_PRODUCT_ID: 'prod_123',
      SPONSOR_CHECKOUT_URL: 'https://buy.polar.sh/test',
    };

    // Total: 200,000 cents ($2,000). capacity = 200,000 * 1.25 = 250,000.
    // Sponsor 1: 150,000 / 250,000 = 0.6
    // Sponsor 2: 50,000 / 250,000 = 0.2
    // available = 1 - 0.8 = 0.2
    fetchMock
      .get('https://api.polar.sh')
      .intercept({
        path: (p) => p.includes('/v1/orders/'),
        method: 'GET',
      })
      .reply(200, {
        items: [
          {
            id: 'ord_1',
            status: 'paid',
            net_amount: 150000,
            customer_id: 'cust_1',
            customer: {
              id: 'cust_1',
              metadata: { sponsor_approved: true },
            },
            created_at: '2026-01-01T00:00:00Z',
            custom_field_data: { sponsor_name: 'Big Sponsor' },
          },
          {
            id: 'ord_2',
            status: 'paid',
            net_amount: 50000,
            customer_id: 'cust_2',
            customer: {
              id: 'cust_2',
              metadata: { sponsor_approved: true },
            },
            created_at: '2026-01-01T00:00:00Z',
            custom_field_data: { sponsor_name: 'Medium Sponsor' },
          },
        ],
        pagination: { max_page: 1 },
      });

    const res = await app.fetch(new Request('https://test/api/sponsors'), testEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.sponsors).toHaveLength(2);
    expect(body.available).toBeGreaterThanOrEqual(0.2);
    const sum = body.sponsors.reduce((acc: number, s: any) => acc + s.weight, 0) + body.available;
    expect(sum).toBeCloseTo(1);
  });

  it('under $1,000 raised the capacity floor applies', async () => {
    const testEnv = {
      ...env,
      POLAR_ACCESS_TOKEN: 'test_token',
      POLAR_PRODUCT_ID: 'prod_123',
      SPONSOR_CHECKOUT_URL: 'https://buy.polar.sh/test',
    };

    // Total: 10,000 cents ($100). Capacity floor = 100,000 cents.
    // Weight = 10,000 / 100,000 = 0.1
    // available = 0.9
    fetchMock
      .get('https://api.polar.sh')
      .intercept({
        path: (p) => p.includes('/v1/orders/'),
        method: 'GET',
      })
      .reply(200, {
        items: [
          {
            id: 'ord_1',
            status: 'paid',
            net_amount: 10000,
            customer_id: 'cust_1',
            customer: {
              id: 'cust_1',
              metadata: { sponsor_approved: true },
            },
            created_at: '2026-01-01T00:00:00Z',
            custom_field_data: { sponsor_name: 'Early Sponsor' },
          },
        ],
        pagination: { max_page: 1 },
      });

    const res = await app.fetch(new Request('https://test/api/sponsors'), testEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.sponsors[0].weight).toBeCloseTo(0.1);
    expect(body.available).toBeCloseTo(0.9);
  });

  it('Polar error returns 200 empty-but-configured with short max-age', async () => {
    const testEnv = {
      ...env,
      POLAR_ACCESS_TOKEN: 'test_token',
      POLAR_PRODUCT_ID: 'prod_123',
      SPONSOR_CHECKOUT_URL: 'https://buy.polar.sh/test',
    };

    fetchMock
      .get('https://api.polar.sh')
      .intercept({
        path: (p) => p.includes('/v1/orders/'),
        method: 'GET',
      })
      .reply(500, 'Internal Server Error');

    const res = await app.fetch(new Request('https://test/api/sponsors'), testEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body).toEqual({
      checkoutUrl: 'https://buy.polar.sh/test',
      sponsors: [],
      available: 1,
    });
    expect(res.headers.get('Cache-Control')).toContain('max-age=60');
  });

  it('response never contains amount, email or the token', async () => {
    const secretToken = 'super_secret_polar_token_xyz';
    const testEnv = {
      ...env,
      POLAR_ACCESS_TOKEN: secretToken,
      POLAR_PRODUCT_ID: 'prod_123',
      SPONSOR_CHECKOUT_URL: 'https://buy.polar.sh/test',
    };

    fetchMock
      .get('https://api.polar.sh')
      .intercept({
        path: (p) => p.includes('/v1/orders/'),
        method: 'GET',
      })
      .reply(200, {
        items: [
          {
            id: 'ord_1',
            status: 'paid',
            net_amount: 10000,
            customer_id: 'cust_1',
            customer: {
              id: 'cust_1',
              email: 'donor@example.com',
              metadata: { sponsor_approved: true },
            },
            created_at: '2026-01-01T00:00:00Z',
            custom_field_data: { sponsor_name: 'Donor' },
          },
        ],
        pagination: { max_page: 1 },
      });

    const res = await app.fetch(new Request('https://test/api/sponsors'), testEnv);
    const text = await res.text();
    expect(text).not.toContain('amount');
    expect(text).not.toContain('email');
    expect(text).not.toContain('donor@example.com');
    expect(text).not.toContain(secretToken);
  });

  it('sponsors are sorted descending by weight', async () => {
    const testEnv = {
      ...env,
      POLAR_ACCESS_TOKEN: 'test_token',
      POLAR_PRODUCT_ID: 'prod_123',
      SPONSOR_CHECKOUT_URL: 'https://buy.polar.sh/test',
    };

    fetchMock
      .get('https://api.polar.sh')
      .intercept({
        path: (p) => p.includes('/v1/orders/'),
        method: 'GET',
      })
      .reply(200, {
        items: [
          {
            id: 'ord_1',
            status: 'paid',
            net_amount: 3000,
            customer_id: 'cust_smaller',
            customer: {
              id: 'cust_smaller',
              metadata: { sponsor_approved: true },
            },
            created_at: '2026-01-01T00:00:00Z',
            custom_field_data: { sponsor_name: 'Smaller Sponsor' },
          },
          {
            id: 'ord_2',
            status: 'paid',
            net_amount: 10000,
            customer_id: 'cust_larger',
            customer: {
              id: 'cust_larger',
              metadata: { sponsor_approved: true },
            },
            created_at: '2026-01-01T00:00:00Z',
            custom_field_data: { sponsor_name: 'Larger Sponsor' },
          },
        ],
        pagination: { max_page: 1 },
      });

    const res = await app.fetch(new Request('https://test/api/sponsors'), testEnv);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.sponsors).toHaveLength(2);
    expect(body.sponsors[0].name).toBe('Larger Sponsor');
    expect(body.sponsors[1].name).toBe('Smaller Sponsor');
    expect(body.sponsors[0].weight).toBeGreaterThan(body.sponsors[1].weight);
  });

  it('caches successful response for 10 minutes (max-age=600)', async () => {
    const testEnv = {
      ...env,
      POLAR_ACCESS_TOKEN: 'test_token',
      POLAR_PRODUCT_ID: 'prod_123',
      SPONSOR_CHECKOUT_URL: 'https://buy.polar.sh/test',
    };

    fetchMock
      .get('https://api.polar.sh')
      .intercept({
        path: (p) => p.includes('/v1/orders/'),
        method: 'GET',
      })
      .reply(200, {
        items: [
          {
            id: 'ord_1',
            status: 'paid',
            net_amount: 5000,
            customer_id: 'cust_1',
            customer: {
              id: 'cust_1',
              metadata: { sponsor_approved: true },
            },
            created_at: '2026-01-01T00:00:00Z',
            custom_field_data: { sponsor_name: 'Cached Sponsor' },
          },
        ],
        pagination: { max_page: 1 },
      });

    const res = await app.fetch(new Request('https://test/api/sponsors'), testEnv);
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('max-age=600');

    // Second request should be served from cache without triggering another fetchMock intercept
    const cachedRes = await app.fetch(new Request('https://test/api/sponsors?extra=query'), testEnv);
    expect(cachedRes.status).toBe(200);
    const body = (await cachedRes.json()) as any;
    expect(body.sponsors[0].name).toBe('Cached Sponsor');
  });

  it('includes CORS headers when Origin matches PAGES_ORIGIN', async () => {
    const res = await SELF.fetch('https://test/api/sponsors', {
      headers: { Origin: env.PAGES_ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(env.PAGES_ORIGIN);
  });
});
