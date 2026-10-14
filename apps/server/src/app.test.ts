import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from './app.js';
import type { CardSearchRequest } from './db/card-definition-repository.js';
import { PlayerIdSchema, RoomIdSchema, type Room } from '@easymtg/shared';
import type { RoomLifecycleResult } from './room-lifecycle-api.js';

describe('server foundation', () => {
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let webRoot: string | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
    if (webRoot) await rm(webRoot, { recursive: true, force: true });
    webRoot = undefined;
  });

  it('serves a health check', async () => {
    app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('issues a cookie on the general page request and refreshes it for an existing Session', async () => {
    webRoot = await mkdtemp(join(tmpdir(), 'easymtg-web-'));
    await writeFile(join(webRoot, 'index.html'), '<!doctype html><html><body>EasyMTG</body></html>');
    const token = 'A'.repeat(43);
    const expiresAt = new Date('2026-11-09T00:00:00.000Z');
    let createCount = 0;
    app = await buildApp({
      secureCookies: false,
      webRoot,
      sessions: {
        createAnonymousUser: async () => { createCount += 1; return { token, expiresAt }; },
        resolveAndTouch: async (receivedToken) => receivedToken === token ? {
          user: { id: 'f2a3aa30-9191-4c48-aa76-84df905f3254', displayName: 'Player', createdAt: '2026-10-10T00:00:00.000Z' },
          expiresAt,
        } : null,
      },
    });

    const firstPage = await app.inject({ method: 'GET', url: '/' });
    expect(firstPage.statusCode).toBe(200);
    expect(firstPage.body).toContain('EasyMTG');
    expect(firstPage.headers['set-cookie']).toContain('easymtg_session=');
    expect(firstPage.headers['set-cookie']).toContain('HttpOnly');
    expect(createCount).toBe(1);

    const returningPage = await app.inject({ method: 'GET', url: '/', headers: { cookie: `easymtg_session=${token}` } });
    expect(returningPage.statusCode).toBe(200);
    expect(returningPage.headers['set-cookie']).toContain('easymtg_session=');
    expect(createCount).toBe(1);
  });

  it('serves the specified authenticated Card Definition search API', async () => {
    const token = 'S'.repeat(43);
    const expiresAt = new Date('2026-11-09T00:00:00.000Z');
    const requests: unknown[] = [];
    app = await buildApp({
      secureCookies: false,
      sessions: { resolveAndTouch: async (receivedToken) => receivedToken === token ? {
        user: { id: 'f2a3aa30-9191-4c48-aa76-84df905f3254', displayName: 'Player', createdAt: '2026-10-10T00:00:00.000Z' },
        expiresAt,
      } : null },
      cardDefinitions: { search: async (input) => {
        requests.push(input);
        return { items: [], page: input.page, pageSize: 50, totalCount: 0, totalPages: 0 };
      } },
    });

    const unauthenticated = await app.inject({ method: 'GET', url: '/api/card-definitions' });
    expect(unauthenticated.statusCode).toBe(401);

    const response = await app.inject({
      method: 'GET', url: '/api/card-definitions?q=blue%20eyes&page=2&sort=japaneseName&order=desc',
      headers: { cookie: `easymtg_session=${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [], page: 2, pageSize: 50, totalCount: 0, totalPages: 0 });
    expect(response.headers['set-cookie']).toContain('easymtg_session=');
    expect(requests).toEqual([{ query: 'blue eyes', page: 2, sort: ['japaneseName'], order: ['desc'] }]);

    const invalidPage = await app.inject({
      method: 'GET', url: '/api/card-definitions?page=0', headers: { cookie: `easymtg_session=${token}` },
    });
    expect(invalidPage.statusCode).toBe(400);
    expect(invalidPage.json().error.code).toBe('INVALID_PAGE');

    const invalidQuery = await app.inject({
      method: 'GET', url: '/api/card-definitions?limit=10', headers: { cookie: `easymtg_session=${token}` },
    });
    expect(invalidQuery.statusCode).toBe(400);
    expect(invalidQuery.json().error.code).toBe('INVALID_REQUEST');
  });

  it('exposes authenticated Room lifecycle HTTP routes and refreshes WebSocket state after mutations', async () => {
    const token = 'R'.repeat(43);
    const userId = 'f2a3aa30-9191-4c48-aa76-84df905f3254';
    const playerId = PlayerIdSchema.parse('player-a');
    const roomId = RoomIdSchema.parse('room-a');
    const room: Room = {
      id: roomId, ownerPlayerId: playerId, status: 'WAITING',
      participants: [{ playerId, deckId: 'deck-secret', connectionState: 'CONNECTED' }],
      createdAt: '2026-10-11T00:00:00.000Z',
    };
    const result: RoomLifecycleResult = { room, playerId, events: [] };
    const calls: string[] = [];
    const updates: Array<{ roomId: string; update: RoomLifecycleResult }> = [];
    app = await buildApp({
      secureCookies: false,
      sessions: { resolveAndTouch: async (receivedToken) => receivedToken === token ? {
        user: { id: userId, displayName: 'Player', createdAt: '2026-10-10T00:00:00.000Z' }, expiresAt: new Date('2026-11-09T00:00:00.000Z'),
      } : null },
      roomLifecycle: {
        getCurrent: async () => ({ room, playerId, selectedDeckId: 'deck-secret' }),
        create: async (_userId, deckId) => { calls.push(`create:${deckId}`); return { ...result, selectedDeckId: deckId }; },
        join: async (_userId, targetRoomId, deckId) => { calls.push(`join:${targetRoomId}:${deckId}`); return { ...result, selectedDeckId: deckId }; },
        leave: async () => { calls.push('leave'); return { ...result, room: null, events: [{ eventId: 'event-left', type: 'RoomPlayerLeft', roomId, playerId }] }; },
        confirmNextGameDeck: async (_userId, composition, unconfirm) => { calls.push(unconfirm ? 'unconfirm' : `confirm:${(composition as { mainboard: string[] }).mainboard.length}`); return result; },
        startNextGame: async () => { calls.push('start'); return result; },
      },
      webSockets: { accept: () => undefined, publishRoomUpdate: async (id, update) => { updates.push({ roomId: id, update }); } },
    });

    expect((await app.inject({ method: 'POST', url: '/api/rooms', payload: { deckId: 'deck-a' } })).statusCode).toBe(401);
    const headers = { cookie: `easymtg_session=${token}` };
    expect((await app.inject({ method: 'POST', url: '/api/rooms', headers, payload: { deckId: 9 } })).statusCode).toBe(400);
    const created = await app.inject({ method: 'POST', url: '/api/rooms', headers, payload: { deckId: 'deck-a' } });
    expect(created.statusCode).toBe(200);
    expect(created.json().room.participants[0]).not.toHaveProperty('deckId');
    expect(created.json().selectedDeckId).toBe('deck-a');
    expect(updates).toHaveLength(1);

    expect((await app.inject({ method: 'POST', url: '/api/rooms/room-a/join', headers, payload: { deckId: 'deck-b' } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: '/api/rooms/current/next-game-deck', headers, payload: { mainboard: Array.from({ length: 60 }, () => 'ABC000'), sideboard: [] } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: '/api/rooms/current/next-game-deck/confirmation', headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/rooms/current/games/next', headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'DELETE', url: '/api/rooms/current', headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/rooms/current', headers })).json()).toMatchObject({ room: { roomId }, playerId, selectedDeckId: 'deck-secret' });
    expect(calls).toEqual(['create:deck-a', 'join:room-a:deck-b', 'confirm:60', 'unconfirm', 'start', 'leave']);
    expect(updates).toHaveLength(6);
  });

  it('protects Admin Card Definition APIs with a separate Bearer token', async () => {
    const token = 'T'.repeat(32);
    const searches: CardSearchRequest[] = [];
    const mutations: Array<{ requestId: string; fingerprint: string }> = [];
    const adminCards = {
      search: async (input: CardSearchRequest) => {
        searches.push(input);
        return { items: [], page: input.page, pageSize: 50, totalCount: 0, totalPages: 0 };
      },
      getLatest: async () => null,
      getVersion: async () => null,
      mutate: async (_adminId: string, requestId: string, fingerprint: string) => {
        mutations.push({ requestId, fingerprint });
        return { status: 201, body: { data: { cardDefinitionId: 'ABC123', status: 'ENABLED', version: { version: 1 } } } };
      },
      create: vi.fn(), appendVersion: vi.fn(), changeStatus: vi.fn(),
    };
    app = await buildApp({ adminApiToken: token, adminCardDefinitions: adminCards });

    const unauthenticated = await app.inject({ method: 'GET', url: '/api/admin/card-definitions' });
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json().error.code).toBe('UNAUTHENTICATED');
    const cookieIsNotAdminAuth = await app.inject({
      method: 'GET', url: '/api/admin/card-definitions', headers: { cookie: `easymtg_session=${token}` },
    });
    expect(cookieIsNotAdminAuth.statusCode).toBe(401);

    const searched = await app.inject({
      method: 'GET', url: '/api/admin/card-definitions?status=DISABLED',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(searched.statusCode).toBe(200);
    expect(searches).toEqual([{
      query: '', page: 1, sort: ['englishName', 'cardDefinitionId'], order: ['asc', 'asc'], status: 'DISABLED',
    }]);

    const requestId = 'f2a3aa30-9191-4c48-aa76-84df905f3254';
    const created = await app.inject({
      method: 'POST', url: '/api/admin/card-definitions', headers: { authorization: `Bearer ${token}` },
      payload: {
        requestId, cardDefinitionId: 'abc123', status: 'ENABLED',
        englishName: 'Test Card', frontImageUrl: 'https://cards.example.test/front.jpg', hasBack: false, rulesData: {},
      },
    });
    expect(created.statusCode).toBe(201);
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.requestId).toBe(requestId);

    const weakTokenConfig = buildApp({ adminApiToken: 'too-short', adminCardDefinitions: adminCards });
    await expect(weakTokenConfig).rejects.toThrow('ADMIN_API_TOKEN must contain at least 32 UTF-8 bytes and no whitespace.');
  });
});
