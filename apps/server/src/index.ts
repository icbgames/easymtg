import { buildApp } from './app.js';
import { createDatabase } from './db/client.js';
import { CardDefinitionRepository } from './db/card-definition-repository.js';
import { SessionRepository } from './db/session-repository.js';
import { GameSyncRepository } from './db/game-sync-repository.js';
import { GameRepository } from './db/game-repository.js';
import { WebSocketSessionManager } from './websocket-session-manager.js';
import { CleanupRepository } from './db/cleanup-repository.js';
import { CleanupWorker } from './cleanup-worker.js';
import { fileURLToPath } from 'node:url';
import { RoomLifecycleApi } from './room-lifecycle-api.js';
import { DeckRepository } from './db/deck-repository.js';

const database = createDatabase();
await database.pool.query('select 1');
const gameRepository = new GameRepository(database.db);
const deckRepository = new DeckRepository(database.db);
const webSocketSessions = new WebSocketSessionManager(new GameSyncRepository(database.db), gameRepository);
await gameRepository.markPlayingGamesDisconnectedAtStartup();
const app = await buildApp({
  cardDefinitions: new CardDefinitionRepository(database.db),
  cardDefinitionDetails: new CardDefinitionRepository(database.db),
  cardDefinitionVersions: new CardDefinitionRepository(database.db),
  currentGameView: new GameSyncRepository(database.db),
  decks: deckRepository,
  sessions: new SessionRepository(database.db),
  webSockets: webSocketSessions,
  roomLifecycle: new RoomLifecycleApi(database.db, undefined, (playerId) => webSocketSessions.getConnectionState(playerId)),
  secureCookies: process.env.NODE_ENV === 'production',
  webRoot: fileURLToPath(new URL('../../web/dist', import.meta.url)),
});
const cleanupWorker = new CleanupWorker(gameRepository, new SessionRepository(database.db), new CleanupRepository(database.db), app.log, undefined, (gameId) => webSocketSessions.releaseAbandonedGame(gameId));
cleanupWorker.start();
app.addHook('onClose', async () => { await cleanupWorker.stop(); await database.pool.end(); });
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';

try {
  await app.listen({ port, host });
} catch (error) {
  app.log.error(error);
  await app.close();
  process.exitCode = 1;
}
