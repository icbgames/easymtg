import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App.js';
import './style.css';

class MockWebSocket extends EventTarget {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = 0;
  readonly sent: unknown[] = [];
  constructor(url: string) {
    super();
    void url;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => { this.readyState = MockWebSocket.OPEN; this.dispatchEvent(new Event('open')); });
  }
  send(data: string) {
    const message: unknown = JSON.parse(data);
    this.sent.push(message);
    if ((message as { type?: string }).type === 'Hello' && activeGameMessage) {
      queueMicrotask(() => this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(activeGameMessage) })));
    }
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }
}

let activeGameMessage: unknown;
let root: Root | undefined;
let host: HTMLDivElement | undefined;

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => data } as Response;
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  host?.remove();
  host = undefined;
  activeGameMessage = undefined;
  MockWebSocket.instances = [];
  vi.unstubAllGlobals();
});

describe('browser UI', () => {
  it('opens the deck editor and keeps an unsaved short deck disabled', async () => {
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/rooms/current') return jsonResponse({ room: null });
      if (url === '/api/decks') return jsonResponse([]);
      if (url.startsWith('/api/card-definitions?')) return jsonResponse({ items: [], totalPages: 0 });
      throw new Error(`Unexpected request: ${url}`);
    }));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root!.render(<App />); await new Promise((resolve) => setTimeout(resolve, 0)); });

    await act(async () => { [...host!.querySelectorAll('button')].find((button) => button.textContent?.includes('デッキを管理'))?.click(); });
    expect(host.textContent).toContain('デッキ');
    await act(async () => { [...host!.querySelectorAll('button')].find((button) => button.textContent?.includes('新しいデッキ'))?.click(); await new Promise((resolve) => setTimeout(resolve, 350)); });
    expect(host.textContent).toContain('カードを検索');
    expect(host.textContent).toContain('あと60枚必要です');
    const save = [...host.querySelectorAll('button')].find((button) => button.textContent?.includes('明示的に保存'));
    expect(save?.disabled).toBe(true);
  });

  it('renders a three-column game screen and sends the selected life increment', async () => {
    const playerId = 'player-one';
    const opponentId = 'player-two';
    const room = { roomId: 'room-one', status: 'IN_MATCH', ownerPlayerId: playerId, matchId: 'match-one', participants: [
      { playerId, connectionState: 'CONNECTED' }, { playerId: opponentId, connectionState: 'CONNECTED' },
    ] };
    const zoneTypes = ['LIBRARY', 'HAND', 'GRAVEYARD', 'EXILE', 'SIDEBOARD'] as const;
    const zones = [
      ...[playerId, opponentId].flatMap((ownerPlayerId) => zoneTypes.map((type) => ({ zoneId: `${ownerPlayerId}-${type}`, type, ownerPlayerId, cards: [] }))),
      { zoneId: 'battlefield', type: 'BATTLEFIELD', ownerPlayerId: null, cards: [] },
    ];
    const gameStateView = {
      gameId: 'game-one', matchId: 'match-one', status: 'PLAYING', turnNumber: 1, activePlayerId: playerId,
      phase: 'BEGINNING', step: 'UNTAP', sequence: 0,
      players: [{ playerId, life: 20 }, { playerId: opponentId, life: 20 }], zones,
    };
    activeGameMessage = { type: 'MatchStateSync', match: { matchId: 'match-one', status: 'ACTIVE', currentGameNumber: 1, activeGameId: 'game-one' } };
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/rooms/current') return jsonResponse({ room, playerId, selectedDeckId: 'deck-one' });
      if (url === '/api/decks') return jsonResponse([]);
      if (url === '/api/rooms/current/game-state') return jsonResponse({ game: { gameId: 'game-one', sequence: 0, gameStateView } });
      throw new Error(`Unexpected request: ${url}`);
    }));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root!.render(<App />); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(host.querySelector('.game-left')).not.toBeNull();
    expect(host.querySelector('.game-center')).not.toBeNull();
    expect(host.querySelector('.system-log')).not.toBeNull();
    expect(host.textContent).toContain('1枚ドロー');
    const lifeButton = [...host.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === 'ライフ +5');
    expect(lifeButton).toBeDefined();
    await act(async () => { lifeButton!.click(); });
    expect(MockWebSocket.instances[0]?.sent).toContainEqual(expect.objectContaining({ type: 'ChangeLife', payload: { amount: 5 } }));
  });

  it('does not refresh a Game after its Concede event has retired it', async () => {
    const playerId = 'player-one';
    const opponentId = 'player-two';
    const room = { roomId: 'room-one', status: 'IN_MATCH', ownerPlayerId: playerId, matchId: 'match-one', participants: [
      { playerId, connectionState: 'CONNECTED' }, { playerId: opponentId, connectionState: 'CONNECTED' },
    ] };
    const zoneTypes = ['LIBRARY', 'HAND', 'GRAVEYARD', 'EXILE', 'SIDEBOARD'] as const;
    const zones = [
      ...[playerId, opponentId].flatMap((ownerPlayerId) => zoneTypes.map((type) => ({ zoneId: `${ownerPlayerId}-${type}`, type, ownerPlayerId, cards: [] }))),
      { zoneId: 'battlefield', type: 'BATTLEFIELD', ownerPlayerId: null, cards: [] },
    ];
    const gameStateView = {
      gameId: 'game-one', matchId: 'match-one', status: 'PLAYING', turnNumber: 1, activePlayerId: playerId,
      phase: 'BEGINNING', step: 'UNTAP', sequence: 0,
      players: [{ playerId, life: 20 }, { playerId: opponentId, life: 20 }], zones,
    };
    activeGameMessage = { type: 'MatchStateSync', match: { matchId: 'match-one', status: 'ACTIVE', currentGameNumber: 1, activeGameId: 'game-one' } };
    let ended = false;
    let gameStateRequests = 0;
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/rooms/current') return jsonResponse({
        room, playerId, selectedDeckId: 'deck-one',
        ...(ended ? { nextGameDeck: { mainboard: [], sideboard: [], confirmed: false, opponentConfirmed: false } } : {}),
      });
      if (url === '/api/decks') return jsonResponse([]);
      if (url === '/api/rooms/current/game-state') {
        gameStateRequests += 1;
        return jsonResponse({ game: ended ? null : { gameId: 'game-one', sequence: 0, gameStateView } });
      }
      throw new Error(`Unexpected request: ${url}`);
    }));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root!.render(<App />); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const socket = MockWebSocket.instances[0]!;
    expect(host.querySelector('.game-center')).not.toBeNull();
    expect(gameStateRequests).toBe(1);
    ended = true;
    await act(async () => {
      socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        type: 'GameEvent', eventId: '00000000-0000-4000-8000-000000000010', gameId: 'game-one', sequence: 1,
        eventType: 'ConcedeApplied', payload: { actorPlayerId: playerId, commandPayload: {} },
      }) }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        eventId: '00000000-0000-4000-8000-000000000011', type: 'GameEnded', roomId: 'room-one', matchId: 'match-one',
        gameId: 'game-one', gameNumber: 1, gameStatus: 'FINISHED',
      }) }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(gameStateRequests).toBe(1);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.textContent).toContain('次のGame用デッキ');
  });

  it('resumes WebSocket synchronization from the last applied Game sequence', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const playerId = 'player-one';
    const opponentId = 'player-two';
    const room = { roomId: 'room-one', status: 'IN_MATCH', ownerPlayerId: playerId, matchId: 'match-one', participants: [
      { playerId, connectionState: 'CONNECTED' }, { playerId: opponentId, connectionState: 'CONNECTED' },
    ] };
    const zoneTypes = ['LIBRARY', 'HAND', 'GRAVEYARD', 'EXILE', 'SIDEBOARD'] as const;
    const zones = [
      ...[playerId, opponentId].flatMap((ownerPlayerId) => zoneTypes.map((type) => ({ zoneId: `${ownerPlayerId}-${type}`, type, ownerPlayerId, cards: [] }))),
      { zoneId: 'battlefield', type: 'BATTLEFIELD', ownerPlayerId: null, cards: [] },
    ];
    let sequence = 0;
    const gameStateView = () => ({
      gameId: 'game-one', matchId: 'match-one', status: 'PLAYING', turnNumber: 1, activePlayerId: playerId,
      phase: 'BEGINNING', step: 'UNTAP', sequence,
      players: [{ playerId, life: 20 }, { playerId: opponentId, life: 20 }], zones,
    });
    activeGameMessage = { type: 'MatchStateSync', match: { matchId: 'match-one', status: 'ACTIVE', currentGameNumber: 1, activeGameId: 'game-one' } };
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/rooms/current') return jsonResponse({ room, playerId, selectedDeckId: 'deck-one' });
      if (url === '/api/decks') return jsonResponse([]);
      if (url === '/api/rooms/current/game-state') return jsonResponse({
        game: { gameId: 'game-one', sequence, gameStateView: gameStateView() },
      });
      throw new Error(`Unexpected request: ${url}`);
    }));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root!.render(<App />); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const firstSocket = MockWebSocket.instances[0]!;
    expect(firstSocket.sent).toContainEqual(expect.objectContaining({ type: 'Hello', lastGameId: null, lastSequence: null }));
    sequence = 1;
    await act(async () => {
      firstSocket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        type: 'GameEvent', eventId: '00000000-0000-4000-8000-000000000001', gameId: 'game-one',
        sequence: 1, eventType: 'ChangeLifeApplied', payload: { actorPlayerId: playerId, commandPayload: { amount: 1 } },
      }) }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      firstSocket.close();
      await new Promise((resolve) => setTimeout(resolve, 1100));
    });

    const secondSocket = MockWebSocket.instances[1];
    expect(secondSocket?.sent).toContainEqual(expect.objectContaining({ type: 'Hello', lastGameId: 'game-one', lastSequence: 1 }));
    await act(async () => {
      secondSocket!.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
        type: 'GameEvent', eventId: '00000000-0000-4000-8000-000000000003', gameId: 'game-one',
        sequence: 3, eventType: 'ChangeLifeApplied', payload: { actorPlayerId: playerId, commandPayload: { amount: 1 } },
      }) }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(secondSocket?.readyState).toBe(3);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });

    const thirdSocket = MockWebSocket.instances[2];
    expect(thirdSocket?.sent).toContainEqual(expect.objectContaining({ type: 'Hello', lastGameId: 'game-one', lastSequence: 1 }));
  });
});
