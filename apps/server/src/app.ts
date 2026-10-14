import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import websocket from '@fastify/websocket';
import { CardDefinitionIdSchema, CardDefinitionSearchResponseSchema, CardDefinitionVersionSchema, DeckIdSchema, DeckListResponseSchema, DeckResponseSchema, DeckWriteSchema, HttpErrorCodeSchema, HTTP_STATUS_BY_ERROR_CODE, NextGameDeckSchema, RoomIdSchema, z, type Deck, type HttpErrorCode } from '@easymtg/shared';
import { RulesDataSchema } from '@easymtg/shared';
import type { CardSearchRequest } from './db/card-definition-repository.js';
import { adminRequestFingerprint, type AdminTransaction } from './db/admin-card-definition-repository.js';
import { readSessionCookie, requireUserSession, type SessionResolver } from './session-auth.js';
import { sessionCookie } from './db/session-repository.js';
import type { WebSocketSessionManager } from './websocket-session-manager.js';
import type { RoomLifecycleApi } from './room-lifecycle-api.js';

export type CardDefinitionSearchService = { search(input: CardSearchRequest): Promise<unknown> };
export type CardDefinitionVersionService = { getVersion(id: string, version: number): Promise<unknown | null> };
export type CardDefinitionDetailService = { getLatest(id: string): Promise<unknown | null> };
export type AdminCardDefinitionService = {
  search(input: CardSearchRequest): Promise<unknown>;
  getLatest(id: string): Promise<unknown | null>;
  getVersion(id: string, version: number): Promise<unknown | null>;
  mutate(adminId: string, requestId: string, fingerprint: string, action: (tx: AdminTransaction) => Promise<{ status: number; body: Record<string, unknown> }>): Promise<{ status: number; body: Record<string, unknown> }>;
  create(tx: AdminTransaction, id: string, status: 'ENABLED' | 'DISABLED', version: import('./db/admin-card-definition-repository.js').AdminVersionInput): Promise<{ status: number; body: Record<string, unknown> }>;
  appendVersion(tx: AdminTransaction, id: string, expectedVersion: number, version: import('./db/admin-card-definition-repository.js').AdminVersionInput, status?: 'ENABLED' | 'DISABLED'): Promise<{ status: number; body: Record<string, unknown> }>;
  changeStatus(tx: AdminTransaction, id: string, status: 'ENABLED' | 'DISABLED'): Promise<{ status: number; body: Record<string, unknown> }>;
};
export type CurrentGameViewService = { getCurrentGameView(userId: string): Promise<{ gameId: string; sequence: number; gameStateView: unknown } | null> };
export type DeckHttpService = { list(userId: string): Promise<Deck[]>; get(userId: string, id: string): Promise<Deck>; save(userId: string, input: { id?: string; name: string; mainboard: string[]; sideboard: string[] }): Promise<Deck>; delete(userId: string, id: string): Promise<void> };
export type AnonymousSessionIssuer = SessionResolver & { createAnonymousUser(displayName: string): Promise<{ token: string; expiresAt: Date }> };
export type AppDependencies = { cardDefinitions?: CardDefinitionSearchService; cardDefinitionDetails?: CardDefinitionDetailService; cardDefinitionVersions?: CardDefinitionVersionService; adminCardDefinitions?: AdminCardDefinitionService; adminApiToken?: string; currentGameView?: CurrentGameViewService; decks?: DeckHttpService; sessions?: AnonymousSessionIssuer; webSockets?: Pick<WebSocketSessionManager, 'accept' | 'publishRoomUpdate'>; roomLifecycle?: Pick<RoomLifecycleApi, 'getCurrent' | 'create' | 'join' | 'leave' | 'confirmNextGameDeck' | 'startNextGame'>; secureCookies?: boolean; webRoot?: string };

export async function buildApp(dependencies: AppDependencies = {}) {
  const app = Fastify({ logger: true });
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  if (dependencies.webRoot) {
    await app.register(fastifyStatic, { root: resolve(dependencies.webRoot), wildcard: true, decorateReply: true });
    if (dependencies.sessions) {
      app.addHook('onRequest', async (request, reply) => {
        if (request.method !== 'GET' || request.url.split('?')[0] !== '/') return;
        const token = readSessionCookie(request.headers.cookie);
        const resolved = token ? await dependencies.sessions!.resolveAndTouch(token) : null;
        const session = resolved ?? await dependencies.sessions!.createAnonymousUser('Anonymous');
        const sessionToken = 'token' in session ? session.token : token!;
        reply.header('set-cookie', sessionCookie(sessionToken, session.expiresAt, dependencies.secureCookies ?? process.env.NODE_ENV === 'production'));
      });
    }
  }

  app.get('/health', async () => ({ status: 'ok' as const }));

  if (dependencies.cardDefinitions && dependencies.sessions) {
    const searchService = dependencies.cardDefinitions;
    app.get('/api/card-definitions', { preHandler: requireUserSession(dependencies.sessions, dependencies.secureCookies) }, async (request, reply) => {
      const parsed = parseCardSearchQuery(request.query);
      if (!parsed.ok) return reply.code(400).send(httpError(parsed.code, parsed.message));
      try {
        return CardDefinitionSearchResponseSchema.parse(await searchService.search(parsed.value));
      } catch (error) {
        request.log.error({ err: error }, 'Card Definition search failed.');
        if (error instanceof RangeError) return reply.code(400).send(httpError('INVALID_REQUEST', 'Invalid search request.'));
        return reply.code(500).send(httpError('INTERNAL_ERROR', 'Internal server error.'));
      }
    });
  }

  if (dependencies.cardDefinitionVersions && dependencies.sessions) {
    app.get('/api/card-definitions/:cardDefinitionId/versions/:version', { preHandler: requireUserSession(dependencies.sessions, dependencies.secureCookies) }, async (request, reply) => {
      const params = z.object({ cardDefinitionId: CardDefinitionIdSchema, version: z.coerce.number().int().positive().safe() }).strict().safeParse(request.params);
      if (!params.success) return reply.code(400).send(httpError('INVALID_REQUEST', 'Invalid Card Definition Version request.'));
      try {
        const result = await dependencies.cardDefinitionVersions!.getVersion(params.data.cardDefinitionId, params.data.version);
        if (!result) return reply.code(404).send(httpError('CARD_DEFINITION_NOT_FOUND', 'Card Definition Version not found.'));
        return reply.send(CardDefinitionVersionSchema.parse(result));
      } catch (error) {
        request.log.error({ err: error }, 'Card Definition Version lookup failed.');
        return reply.code(500).send(httpError('INTERNAL_ERROR', 'Internal server error.'));
      }
    });
  }

  if (dependencies.cardDefinitionDetails && dependencies.sessions) {
    app.get('/api/card-definitions/:cardDefinitionId', { preHandler: requireUserSession(dependencies.sessions, dependencies.secureCookies) }, async (request, reply) => {
      const params = z.object({ cardDefinitionId: CardDefinitionIdSchema }).strict().safeParse(request.params);
      if (!params.success) return reply.code(400).send(httpError('INVALID_REQUEST', 'Invalid Card Definition ID.'));
      try {
        const result = await dependencies.cardDefinitionDetails!.getLatest(params.data.cardDefinitionId);
        if (!result) return reply.code(404).send(httpError('CARD_DEFINITION_NOT_FOUND', 'Card Definition not found.'));
        return reply.send(CardDefinitionVersionSchema.extend({ status: z.enum(['ENABLED', 'DISABLED']) }).parse(result));
      } catch (error) {
        request.log.error({ err: error }, 'Card Definition lookup failed.');
        return reply.code(500).send(httpError('INTERNAL_ERROR', 'Internal server error.'));
      }
    });
  }

  if (dependencies.adminApiToken && dependencies.adminCardDefinitions) {
    if (Buffer.byteLength(dependencies.adminApiToken, 'utf8') < 32 || /\s/u.test(dependencies.adminApiToken)) {
      throw new Error('ADMIN_API_TOKEN must contain at least 32 UTF-8 bytes and no whitespace.');
    }
    const adminCards = dependencies.adminCardDefinitions;
    const adminRoute = { preHandler: async (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply) => {
      if (!validBearerToken(request.headers.authorization, dependencies.adminApiToken!)) {
        return reply.code(401).send(httpError('UNAUTHENTICATED', 'Admin authentication required.'));
      }
    } };
    const executeMutation = async (
      request: import('fastify').FastifyRequest,
      reply: import('fastify').FastifyReply,
      requestId: string,
      fingerprintValue: unknown,
      action: (tx: AdminTransaction) => Promise<{ status: number; body: Record<string, unknown> }>,
    ) => {
      try {
        const result = await adminCards.mutate('single-admin', requestId, adminRequestFingerprint(fingerprintValue), action);
        return reply.code(result.status).send(result.body);
      } catch (error) {
        request.log.error({ err: error }, 'Admin Card Definition operation failed.');
        return reply.code(500).send(httpError('INTERNAL_ERROR', 'Internal server error.'));
      }
    };
    const requestIdSchema = z.string().uuid();
    const statusSchema = z.enum(['ENABLED', 'DISABLED']);
    const versionInputSchema = z.object({
      englishName: z.string().trim().min(1),
      japaneseName: z.string().trim().min(1).optional(),
      backName: z.string().trim().min(1).nullable().optional(),
      frontImageUrl: z.string().url().refine((url) => url.startsWith('https://')),
      backImageUrl: z.string().url().refine((url) => url.startsWith('https://')).nullable().optional(),
      hasBack: z.boolean(),
      changeDescription: z.string().optional(),
      rulesData: RulesDataSchema,
    }).strict().superRefine((version, context) => {
      if (version.hasBack && !version.backImageUrl) {
        context.addIssue({ code: 'custom', path: ['backImageUrl'], message: 'backImageUrl is required when hasBack is true.' });
      }
      if (!version.hasBack && (version.backImageUrl != null || version.backName != null)) {
        context.addIssue({ code: 'custom', path: ['backImageUrl'], message: 'Back metadata is not allowed when hasBack is false.' });
      }
    });
    const classifyInputError = (issues: Array<{ path: PropertyKey[] }>, raw: unknown) => {
      if (!raw || typeof raw !== 'object') return 'INVALID_REQUEST' as const;
      const body = raw as Record<string, unknown>;
      return issues.some(({ path }) => (path[0] === 'frontImageUrl' || path[0] === 'backImageUrl') && typeof body[path[0]] === 'string')
        ? 'INVALID_IMAGE_URL' as const : 'INVALID_REQUEST' as const;
    };

    app.get('/api/admin/card-definitions', adminRoute, async (request, reply) => {
      const parsed = parseAdminCardSearchQuery(request.query);
      if (!parsed.ok) return reply.code(HTTP_STATUS_BY_ERROR_CODE[parsed.code]).send(httpError(parsed.code, parsed.message));
      try { return reply.send(CardDefinitionSearchResponseSchema.parse(await adminCards.search(parsed.value))); }
      catch (error) {
        request.log.error({ err: error }, 'Admin Card Definition search failed.');
        return reply.code(500).send(httpError('INTERNAL_ERROR', 'Internal server error.'));
      }
    });
    app.get('/api/admin/card-definitions/:cardDefinitionId/versions/:version', adminRoute, async (request, reply) => {
      const params = z.object({ cardDefinitionId: CardDefinitionIdSchema, version: z.coerce.number().int().positive().safe() }).strict().safeParse(request.params);
      if (!params.success) return reply.code(400).send(httpError('INVALID_REQUEST', 'Invalid Card Definition Version request.'));
      try {
        const version = await adminCards.getVersion(params.data.cardDefinitionId, params.data.version);
        return version ? reply.send(CardDefinitionVersionSchema.parse(version)) : reply.code(404).send(httpError('CARD_DEFINITION_NOT_FOUND', 'Card Definition Version not found.'));
      } catch (error) {
        request.log.error({ err: error }, 'Admin Card Definition Version lookup failed.');
        return reply.code(500).send(httpError('INTERNAL_ERROR', 'Internal server error.'));
      }
    });
    app.get('/api/admin/card-definitions/:cardDefinitionId', adminRoute, async (request, reply) => {
      const params = z.object({ cardDefinitionId: CardDefinitionIdSchema }).strict().safeParse(request.params);
      if (!params.success) return reply.code(400).send(httpError('INVALID_REQUEST', 'Invalid Card Definition ID.'));
      try {
        const definition = await adminCards.getLatest(params.data.cardDefinitionId);
        return definition ? reply.send(CardDefinitionVersionSchema.extend({ status: statusSchema }).parse(definition)) : reply.code(404).send(httpError('CARD_DEFINITION_NOT_FOUND', 'Card Definition not found.'));
      } catch (error) {
        request.log.error({ err: error }, 'Admin Card Definition lookup failed.');
        return reply.code(500).send(httpError('INTERNAL_ERROR', 'Internal server error.'));
      }
    });
    app.post('/api/admin/card-definitions', adminRoute, async (request, reply) => {
      const raw = request.body;
      const envelope = z.object({ requestId: requestIdSchema }).passthrough().safeParse(raw);
      if (!envelope.success) return reply.code(400).send(httpError('INVALID_REQUEST', 'A valid requestId is required.'));
      const parsed = z.object({
        requestId: requestIdSchema, cardDefinitionId: z.string().regex(/^[A-Za-z]{3}\d{3}$/u),
        status: statusSchema, ...versionInputSchema.shape,
      }).strict().safeParse(raw);
      return executeMutation(request, reply, envelope.data.requestId, { method: 'POST', route: '/api/admin/card-definitions', body: raw }, async (tx) => {
        if (!parsed.success) return { status: 400, body: httpError(classifyInputError(parsed.error.issues, raw), 'Invalid Card Definition request.') };
        return adminCards.create(tx, parsed.data.cardDefinitionId.toUpperCase(), parsed.data.status, parsed.data);
      });
    });
    app.post('/api/admin/card-definitions/:cardDefinitionId/versions', adminRoute, async (request, reply) => {
      const params = z.object({ cardDefinitionId: CardDefinitionIdSchema }).strict().safeParse(request.params);
      const envelope = z.object({ requestId: requestIdSchema }).passthrough().safeParse(request.body);
      if (!params.success || !envelope.success) return reply.code(400).send(httpError('INVALID_REQUEST', 'A valid Card Definition ID and requestId are required.'));
      const parsed = z.object({
        requestId: requestIdSchema, expectedVersion: z.number().int().positive().safe(),
        ...versionInputSchema.shape,
      }).strict().safeParse(request.body);
      return executeMutation(request, reply, envelope.data.requestId, { method: 'POST', route: `/api/admin/card-definitions/${params.data.cardDefinitionId}/versions`, body: request.body }, async (tx) => {
        if (!parsed.success) return { status: 400, body: httpError(classifyInputError(parsed.error.issues, request.body), 'Invalid Card Definition Version request.') };
        return adminCards.appendVersion(tx, params.data.cardDefinitionId, parsed.data.expectedVersion, parsed.data);
      });
    });
    app.patch('/api/admin/card-definitions/:cardDefinitionId/status', adminRoute, async (request, reply) => {
      const params = z.object({ cardDefinitionId: CardDefinitionIdSchema }).strict().safeParse(request.params);
      const envelope = z.object({ requestId: requestIdSchema }).passthrough().safeParse(request.body);
      if (!params.success || !envelope.success) return reply.code(400).send(httpError('INVALID_REQUEST', 'A valid Card Definition ID and requestId are required.'));
      const parsed = z.object({ requestId: requestIdSchema, status: statusSchema }).strict().safeParse(request.body);
      return executeMutation(request, reply, envelope.data.requestId, { method: 'PATCH', route: `/api/admin/card-definitions/${params.data.cardDefinitionId}/status`, body: request.body }, async (tx) => {
        if (!parsed.success) return { status: 400, body: httpError('INVALID_REQUEST', 'Invalid Status update request.') };
        return adminCards.changeStatus(tx, params.data.cardDefinitionId, parsed.data.status);
      });
    });
    app.patch('/api/admin/card-definitions/:cardDefinitionId/version-and-status', adminRoute, async (request, reply) => {
      const params = z.object({ cardDefinitionId: CardDefinitionIdSchema }).strict().safeParse(request.params);
      const envelope = z.object({ requestId: requestIdSchema }).passthrough().safeParse(request.body);
      if (!params.success || !envelope.success) return reply.code(400).send(httpError('INVALID_REQUEST', 'A valid Card Definition ID and requestId are required.'));
      const parsed = z.object({
        requestId: requestIdSchema, expectedVersion: z.number().int().positive().safe(), status: statusSchema,
        ...versionInputSchema.shape,
      }).strict().safeParse(request.body);
      return executeMutation(request, reply, envelope.data.requestId, { method: 'PATCH', route: `/api/admin/card-definitions/${params.data.cardDefinitionId}/version-and-status`, body: request.body }, async (tx) => {
        if (!parsed.success) return { status: 400, body: httpError(classifyInputError(parsed.error.issues, request.body), 'Invalid Card Definition update request.') };
        return adminCards.appendVersion(tx, params.data.cardDefinitionId, parsed.data.expectedVersion, parsed.data, parsed.data.status);
      });
    });
  }

  if (dependencies.decks && dependencies.sessions) {
    const decks = dependencies.decks;
    const getUserId = (request: import('fastify').FastifyRequest) => request.sessionUser!.id;
    const handleDeckError = (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply, error: unknown) => {
      const raw = error && typeof error === 'object' && 'code' in error ? error.code : error instanceof Error ? error.message : undefined;
      const parsed = HttpErrorCodeSchema.safeParse(raw === 'INVALID_DECK' ? 'DECK_INVALID' : raw);
      if (parsed.success) return reply.code(HTTP_STATUS_BY_ERROR_CODE[parsed.data]).send(httpError(parsed.data, lifecycleErrorMessage(parsed.data)));
      request.log.error({ err: error }, 'Deck API operation failed.');
      return reply.code(500).send(httpError('INTERNAL_ERROR', 'Internal server error.'));
    };
    app.get('/api/decks', { preHandler: requireUserSession(dependencies.sessions, dependencies.secureCookies) }, async (request, reply) => {
      try {
        const result = await decks.list(getUserId(request));
        const summaries = result.map(({ id, name, mainboard, sideboard, updatedAt }) => ({ id, name, mainboardCount: mainboard.length, sideboardCount: sideboard.length, updatedAt }));
        return reply.send(DeckListResponseSchema.parse(summaries));
      } catch (error) { return handleDeckError(request, reply, error); }
    });
    app.post('/api/decks', { preHandler: requireUserSession(dependencies.sessions, dependencies.secureCookies) }, async (request, reply) => {
      const body = DeckWriteSchema.safeParse(request.body);
      if (!body.success) return reply.code(400).send(httpError('DECK_INVALID', 'The Deck does not satisfy the save requirements.'));
      try { return reply.send(deckPublic(await decks.save(getUserId(request), body.data))); }
      catch (error) { return handleDeckError(request, reply, error); }
    });
    app.get('/api/decks/:deckId', { preHandler: requireUserSession(dependencies.sessions, dependencies.secureCookies) }, async (request, reply) => {
      const params = z.object({ deckId: DeckIdSchema }).strict().safeParse(request.params);
      if (!params.success) return reply.code(400).send(httpError('INVALID_REQUEST', 'Invalid Deck ID.'));
      try { return reply.send(deckPublic(await decks.get(getUserId(request), params.data.deckId))); }
      catch (error) { return handleDeckError(request, reply, error); }
    });
    app.put('/api/decks/:deckId', { preHandler: requireUserSession(dependencies.sessions, dependencies.secureCookies) }, async (request, reply) => {
      const params = z.object({ deckId: DeckIdSchema }).strict().safeParse(request.params);
      const body = DeckWriteSchema.safeParse(request.body);
      if (!params.success) return reply.code(400).send(httpError('INVALID_REQUEST', 'Invalid Deck ID.'));
      if (!body.success) return reply.code(400).send(httpError('DECK_INVALID', 'The Deck does not satisfy the save requirements.'));
      try { return reply.send(deckPublic(await decks.save(getUserId(request), { ...body.data, id: params.data.deckId }))); }
      catch (error) { return handleDeckError(request, reply, error); }
    });
    app.delete('/api/decks/:deckId', { preHandler: requireUserSession(dependencies.sessions, dependencies.secureCookies) }, async (request, reply) => {
      const params = z.object({ deckId: DeckIdSchema }).strict().safeParse(request.params);
      if (!params.success) return reply.code(400).send(httpError('INVALID_REQUEST', 'Invalid Deck ID.'));
      try { await decks.delete(getUserId(request), params.data.deckId); return reply.send({ deleted: true }); }
      catch (error) { return handleDeckError(request, reply, error); }
    });
  }

  if (dependencies.currentGameView && dependencies.sessions) {
    app.get('/api/rooms/current/game-state', { preHandler: requireUserSession(dependencies.sessions, dependencies.secureCookies) }, async (request, reply) => {
      try { return reply.send({ game: await dependencies.currentGameView!.getCurrentGameView(request.sessionUser!.id) }); }
      catch (error) {
        request.log.error({ err: error }, 'Current Game state lookup failed.');
        return reply.code(500).send(httpError('INTERNAL_ERROR', 'Internal server error.'));
      }
    });
  }

  if (dependencies.roomLifecycle && dependencies.sessions) {
    const lifecycle = dependencies.roomLifecycle;
    const mutate = async (request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply, operation: () => Promise<import('./room-lifecycle-api.js').RoomLifecycleResult>) => {
      try {
        if (!request.sessionUser) return reply.code(401).send(httpError('UNAUTHENTICATED', 'Authentication required.'));
        const result = await operation();
        const roomId = result.room?.id ?? result.events[0]?.roomId;
        if (roomId) await dependencies.webSockets?.publishRoomUpdate(roomId, result);
        return reply.send(roomLifecycleResponse(result));
      } catch (error) {
        const code = HttpErrorCodeSchema.safeParse(error && typeof error === 'object' && 'code' in error ? error.code : error instanceof Error ? error.message : undefined);
        if (code.success) return reply.code(HTTP_STATUS_BY_ERROR_CODE[code.data]).send(httpError(code.data, lifecycleErrorMessage(code.data)));
        request.log.error({ err: error }, 'Room lifecycle operation failed.');
        return reply.code(500).send(httpError('INTERNAL_ERROR', 'Internal server error.'));
      }
    };
    const getUserId = (request: import('fastify').FastifyRequest) => request.sessionUser!.id;
    const deckBody = z.object({ deckId: DeckIdSchema }).strict();

    app.get('/api/rooms/current', { preHandler: requireUserSession(dependencies.sessions, dependencies.secureCookies) }, async (request, reply) => {
      try {
        const room = await lifecycle.getCurrent(getUserId(request));
        return reply.send(room ? { room: publicRoom(room.room), playerId: room.playerId, selectedDeckId: room.selectedDeckId, ...(room.nextGameDeck ? { nextGameDeck: room.nextGameDeck } : {}) } : { room: null });
      } catch (error) {
        request.log.error({ err: error }, 'Room lookup failed.');
        return reply.code(500).send(httpError('INTERNAL_ERROR', 'Internal server error.'));
      }
    });
    app.post('/api/rooms', { preHandler: requireUserSession(dependencies.sessions, dependencies.secureCookies) }, async (request, reply) => {
      const parsed = deckBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send(httpError('INVALID_REQUEST', 'Invalid request body.'));
      return mutate(request, reply, () => lifecycle.create(getUserId(request), parsed.data.deckId));
    });
    app.post('/api/rooms/:roomId/join', { preHandler: requireUserSession(dependencies.sessions, dependencies.secureCookies) }, async (request, reply) => {
      const params = z.object({ roomId: RoomIdSchema }).strict().safeParse(request.params);
      const body = deckBody.safeParse(request.body);
      if (!params.success || !body.success) return reply.code(400).send(httpError('INVALID_REQUEST', 'Invalid request body or path.'));
      return mutate(request, reply, () => lifecycle.join(getUserId(request), params.data.roomId, body.data.deckId));
    });
    app.delete('/api/rooms/current', { preHandler: requireUserSession(dependencies.sessions, dependencies.secureCookies) }, async (request, reply) =>
      mutate(request, reply, () => lifecycle.leave(getUserId(request))));
    app.put('/api/rooms/current/next-game-deck', { preHandler: requireUserSession(dependencies.sessions, dependencies.secureCookies) }, async (request, reply) => {
      const parsed = NextGameDeckSchema.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send(httpError('DECK_INVALID', 'Invalid next-Game Deck composition.'));
      return mutate(request, reply, () => lifecycle.confirmNextGameDeck(getUserId(request), parsed.data));
    });
    app.delete('/api/rooms/current/next-game-deck/confirmation', { preHandler: requireUserSession(dependencies.sessions, dependencies.secureCookies) }, async (request, reply) =>
      mutate(request, reply, () => lifecycle.confirmNextGameDeck(getUserId(request), {}, true)));
    app.post('/api/rooms/current/games/next', { preHandler: requireUserSession(dependencies.sessions, dependencies.secureCookies) }, async (request, reply) =>
      mutate(request, reply, () => lifecycle.startNextGame(getUserId(request))));
  }

  if (dependencies.sessions && dependencies.webSockets) {
    app.get('/ws', { websocket: true, preHandler: requireUserSession(dependencies.sessions, dependencies.secureCookies) }, (socket, request) => {
      const user = request.sessionUser;
      if (user) dependencies.webSockets!.accept(user.id, socket, request.log);
      else socket.close(1008, 'Authentication required.');
    });
  }

  return app;
}

function parseCardSearchQuery(value: unknown, admin = false):
  | { ok: true; value: { query: string; page: number; sort: Array<'englishName' | 'japaneseName' | 'cardDefinitionId'>; order: Array<'asc' | 'desc'>; status?: 'ENABLED' | 'DISABLED' | 'ALL' } }
  | { ok: false; code: HttpErrorCode; message: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, code: 'INVALID_REQUEST', message: 'Invalid query parameters.' };
  const query = value as Record<string, unknown>;
  const allowed = new Set(['q', 'page', 'sort', 'order', 'status']);
  if (Object.keys(query).some((key) => !allowed.has(key)) || Object.values(query).some((item) => typeof item !== 'string')) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'Invalid query parameters.' };
  }
  if (admin ? query.status !== undefined && query.status !== 'ENABLED' && query.status !== 'DISABLED' : query.status !== undefined && query.status !== 'ENABLED') {
    return { ok: false, code: 'INVALID_REQUEST', message: 'Invalid status filter.' };
  }
  const search = typeof query.q === 'string' ? query.q.normalize('NFKC').trim() : '';
  if (search.length > 100) return { ok: false, code: 'INVALID_REQUEST', message: 'Search query is too long.' };

  let page = 1;
  if (query.page !== undefined) {
    if (!/^\d+$/u.test(query.page as string) || Number(query.page) < 1 || !Number.isSafeInteger(Number(query.page))) {
      return { ok: false, code: 'INVALID_PAGE', message: 'Invalid page number.' };
    }
    page = Number(query.page);
  }
  const supportedSort = ['englishName', 'japaneseName', 'cardDefinitionId'] as const;
  const sort = query.sort === undefined ? ['englishName', 'cardDefinitionId'] : (query.sort as string).split(',');
  if (sort.length === 0 || sort.some((field) => !supportedSort.includes(field as typeof supportedSort[number])) || new Set(sort).size !== sort.length) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'Invalid sort fields.' };
  }
  const order = query.order === undefined ? sort.map(() => 'asc') : (query.order as string).split(',');
  if (order.length !== sort.length || order.some((direction) => direction !== 'asc' && direction !== 'desc')) {
    return { ok: false, code: 'INVALID_REQUEST', message: 'Sort and order fields must correspond.' };
  }
  return {
    ok: true,
    value: {
      query: search,
      page,
      sort: sort as Array<'englishName' | 'japaneseName' | 'cardDefinitionId'>,
      order: order as Array<'asc' | 'desc'>,
      ...(admin ? { status: query.status === 'ENABLED' || query.status === 'DISABLED' ? query.status : 'ALL' } : {}),
    },
  };
}

function parseAdminCardSearchQuery(value: unknown) {
  return parseCardSearchQuery(value, true);
}

function validBearerToken(header: string | undefined, expected: string) {
  if (!header) return false;
  const match = /^Bearer ([^\s]+)$/iu.exec(header);
  if (!match) return false;
  const received = Buffer.from(match[1]!, 'utf8');
  const configured = Buffer.from(expected, 'utf8');
  return received.length === configured.length && timingSafeEqual(received, configured);
}

function httpError(code: HttpErrorCode, message: string) {
  return { error: { code, message } };
}

function publicRoomResponse(result: import('./room-lifecycle-api.js').RoomLifecycleResult) {
  return {
    room: result.room ? publicRoom(result.room) : null,
    playerId: result.playerId,
    ...(result.selectedDeckId ? { selectedDeckId: result.selectedDeckId } : {}),
    ...(result.gameId ? { gameId: result.gameId } : {}),
    ...(result.gameNumber ? { gameNumber: result.gameNumber } : {}),
  };
}

function roomLifecycleResponse(result: import('./room-lifecycle-api.js').RoomLifecycleResult) { return publicRoomResponse(result); }

function publicRoom(room: import('@easymtg/shared').Room) {
  return {
    roomId: room.id, status: room.status, ownerPlayerId: room.ownerPlayerId,
    participants: room.participants.map(({ playerId, connectionState }) => ({ playerId, connectionState })),
    ...(room.matchId ? { matchId: room.matchId } : {}),
  };
}

function deckPublic(deck: Deck) {
  return DeckResponseSchema.parse({ id: deck.id, name: deck.name, mainboard: deck.mainboard, sideboard: deck.sideboard, updatedAt: deck.updatedAt });
}

function lifecycleErrorMessage(code: HttpErrorCode) {
  return code === 'FORBIDDEN' ? 'This operation is not allowed.' : code === 'INVALID_REQUEST' || code === 'DECK_INVALID' || code === 'CARD_UNAVAILABLE' ? 'The supplied request or Deck is invalid.' : `Room operation failed: ${code}.`;
}
