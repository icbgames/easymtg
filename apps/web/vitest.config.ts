import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@easymtg/game/view': fileURLToPath(new URL('../../packages/game/src/model.ts', import.meta.url)) } },
  test: {
    environment: 'jsdom',
    exclude: ['**/node_modules/**', '**/dist/**', '**/.git/**'],
  },
});
