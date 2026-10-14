import type { CleanupRepository } from './db/cleanup-repository.js';
import type { GameRepository } from './db/game-repository.js';
import type { SessionRepository } from './db/session-repository.js';

export interface CleanupLogger { error(fields: Record<string, unknown>, message: string): void; info(fields: Record<string, unknown>, message: string): void }

/** Bounded periodic cleanup; each repository operation is idempotent and safe to retry. */
export class CleanupWorker {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;

  constructor(
    private readonly games: GameRepository,
    private readonly sessions: SessionRepository,
    private readonly cleanup: CleanupRepository,
    private readonly logger: CleanupLogger,
    private readonly now: () => Date = () => new Date(),
    private readonly onAbandoned: (gameId: string) => void = () => undefined,
  ) {}

  start(intervalMs = 60_000) {
    if (this.timer) return;
    void this.run();
    this.timer = setInterval(() => { void this.run(); }, intervalMs);
    this.timer.unref();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  private run(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.runOnce().catch((error: unknown) => {
      this.logger.error({ err: error }, 'Periodic cleanup failed.');
    }).finally(() => { this.running = undefined; });
    return this.running;
  }

  private async runOnce() {
    const now = this.now();
    const abandoned = await this.games.abandonExpiredBatch(now);
    for (const game of abandoned) {
      this.onAbandoned(game.gameId);
      this.logger.info({ gameId: game.gameId, roomId: game.roomId, matchId: game.matchId, gameNumber: game.gameNumber }, 'Game abandoned after reconnect grace period.');
    }
    await this.sessions.deleteExpiredBatch();
    await this.cleanup.deleteUnreferencedCardVersions();
    await this.cleanup.deleteExpiredAdminResults(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000));
  }
}
