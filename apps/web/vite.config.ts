import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default {
  resolve: { alias: { '@easymtg/game/view': fileURLToPath(new URL('../../packages/game/src/model.ts', import.meta.url)) } },
  plugins: [react(), {
    name: 'easy-mtg-page-session',
    configureServer(server: import('vite').ViteDevServer) {
      const target = (process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000').replace(/\/$/u, '');
      server.middlewares.use((request, response, next) => {
        if (request.method !== 'GET' || request.url?.split('?')[0] !== '/') return next();
        const cookie = request.headers.cookie;
        void fetch(`${target}/`, { headers: { accept: 'text/html', ...(cookie ? { cookie } : {}) } })
          .then((pageResponse) => {
            const setCookies = pageResponse.headers.getSetCookie();
            if (setCookies.length) response.setHeader('set-cookie', setCookies);
            next();
          })
          .catch((error: unknown) => {
            server.config.logger.error(`Unable to initialize page session through API server: ${String(error)}`);
            next();
          });
      });
    },
  }],
  server: {
    strictPort: true,
    proxy: {
      '/api': { target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000' },
      '/ws': { target: process.env.API_PROXY_TARGET ?? 'http://127.0.0.1:3000', ws: true },
    },
  },
};
