import { defineWorkersConfig, readD1Migrations } from '@cloudflare/vitest-pool-workers/config';
import path from 'node:path';

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.resolve(__dirname, '../../migrations'));
  return {
    test: {
      setupFiles: ['./tests/setup.ts'],
      poolOptions: {
        workers: {
          wrangler: { configPath: './wrangler.toml' },
          // Disabled because sqlite-backed Durable Objects with live WebSocket
          // sessions hold SHM file locks that prevent per-test storage pops.
          // We instead reset DB state explicitly in tests when needed.
          isolatedStorage: false,
          singleWorker: true,
          miniflare: {
            compatibilityFlags: ['nodejs_compat'],
            bindings: { TEST_MIGRATIONS: migrations },
            ratelimits: {
              ROOM_CREATE_LIMITER: {
                simple: { limit: 10, period: 60 },
              },
            },
          },
        },
      },
    },
  };
});
