import { describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.js';
import { registerGracefulShutdown } from './graceful-shutdown.js';

describe('graceful shutdown', () => {
  it('closes Fastify once when it receives a termination signal', async () => {
    const app = await buildApp();
    const close = vi.spyOn(app, 'close').mockResolvedValue(undefined);
    const handlers = new Map<'SIGINT' | 'SIGTERM', () => void>();
    registerGracefulShutdown(app, (signal, handler) => handlers.set(signal, handler));

    handlers.get('SIGTERM')!();
    handlers.get('SIGINT')!();

    expect(close).toHaveBeenCalledTimes(1);
    close.mockRestore();
    await app.close();
  });
});
