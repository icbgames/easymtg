import type { FastifyInstance } from 'fastify';

type ShutdownSignal = 'SIGINT' | 'SIGTERM';
type RegisterSignalHandler = (signal: ShutdownSignal, handler: () => void) => void;

export function registerGracefulShutdown(
  app: Pick<FastifyInstance, 'close' | 'log'>,
  registerSignalHandler: RegisterSignalHandler = (signal, handler) => { process.once(signal, handler); },
): void {
  let closing = false;
  const shutdown = (signal: ShutdownSignal) => {
    if (closing) return;
    closing = true;
    void app.close().catch((error: unknown) => {
      app.log.error({ err: error, signal }, 'Failed to close the server cleanly.');
      process.exitCode = 1;
    });
  };

  registerSignalHandler('SIGINT', () => shutdown('SIGINT'));
  registerSignalHandler('SIGTERM', () => shutdown('SIGTERM'));
}
