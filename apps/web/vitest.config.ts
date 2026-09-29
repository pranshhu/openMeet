import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  esbuild: {
    jsx: 'automatic',
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    passWithNoTests: true,
  },
  resolve: {
    alias: {
      '@openmeet/protocol': fileURLToPath(
        new URL('../../packages/protocol/src/index.ts', import.meta.url)
      ),
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
});
