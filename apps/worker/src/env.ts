export interface Env {
  DB: D1Database;
  ROOM_DO: DurableObjectNamespace;
  ROOM_CREATE_LIMITER?: RateLimit;
  TURN_CRED_LIMITER?: RateLimit;
  PAGES_ORIGIN: string;
  TURN_API_TOKEN?: string;
  TURN_APP_ID?: string;
  /**
   * Self-hosted TURN (coturn etc). Takes precedence over the Cloudflare mint, so
   * an operator can run openMeet with no third party in the media path at all.
   * TURN_URLS is comma-separated; static long-term credentials.
   */
  TURN_URLS?: string;
  TURN_USERNAME?: string;
  TURN_CREDENTIAL?: string;
  POLAR_ACCESS_TOKEN?: string;
  POLAR_PRODUCT_ID?: string;
  SPONSOR_CHECKOUT_URL?: string;
  POLAR_API_BASE?: string;
}
