import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App.js';
import './style.css';
import './battlefield.css';

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

  it('sorts deck editor card rows by type and then cost without changing add controls', async () => {
    const cards = [
      { cardDefinitionId: 'CRE001', version: 1, status: 'ENABLED', englishName: 'Creature', japaneseName: 'Creature', hasBack: false, frontImageUrl: 'https://example.com/card.webp', rulesData: { type: 'Creature', cost: 2 }, createdAt: '2026-01-01T00:00:00.000Z' },
      { cardDefinitionId: 'ART002', version: 1, status: 'ENABLED', englishName: 'Artifact 5', japaneseName: 'Artifact 5', hasBack: false, frontImageUrl: 'https://example.com/card.webp', rulesData: { type: 'Artifact', cost: 5 }, createdAt: '2026-01-01T00:00:00.000Z' },
      { cardDefinitionId: 'ART001', version: 1, status: 'ENABLED', englishName: 'Artifact 1', japaneseName: 'Artifact 1', hasBack: false, frontImageUrl: 'https://example.com/card.webp', rulesData: { type: 'Artifact', cost: 1 }, createdAt: '2026-01-01T00:00:00.000Z' },
      { cardDefinitionId: 'ART003', version: 1, status: 'ENABLED', englishName: 'Artifact unknown cost', japaneseName: 'Artifact unknown cost', hasBack: false, frontImageUrl: 'https://example.com/card.webp', rulesData: { type: 'Artifact' }, createdAt: '2026-01-01T00:00:00.000Z' },
      { cardDefinitionId: 'UNT001', version: 1, status: 'ENABLED', englishName: 'Unknown type', japaneseName: 'Unknown type', hasBack: false, frontImageUrl: 'https://example.com/card.webp', rulesData: { cost: 0 }, createdAt: '2026-01-01T00:00:00.000Z' },
    ];
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/rooms/current') return jsonResponse({ room: null });
      if (url === '/api/decks') return jsonResponse([]);
      if (url.startsWith('/api/card-definitions?')) return jsonResponse({ items: cards, totalPages: 1 });
      throw new Error(`Unexpected request: ${url}`);
    }));
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => { root!.render(<App />); await new Promise((resolve) => setTimeout(resolve, 0)); });
    await act(async () => { [...host!.querySelectorAll('button')].find((button) => button.textContent?.includes('デッキを管理'))?.click(); });
    await act(async () => { [...host!.querySelectorAll('button')].find((button) => button.textContent?.includes('新しいデッキ'))?.click(); await new Promise((resolve) => setTimeout(resolve, 350)); });

    for (const card of cards) {
      await act(async () => { host!.querySelector<HTMLButtonElement>(`button[aria-label="${card.englishName}をMainboardに追加"]`)?.click(); });
    }
    const mainboardRows = host.querySelectorAll('.board-editor ul li .board-card-name');
    expect([...mainboardRows].map((row) => row.querySelector('small')?.textContent?.slice(0, 6))).toEqual([
      'ART001', 'ART002', 'ART003', 'CRE001', 'UNT001',
    ]);
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

  it('keeps battlefield perspective, card orientation, and intra-battlefield dragging consistent', async () => {
    const playerId = 'player-two';
    const opponentId = 'player-one';
    const room = { roomId: 'room-one', status: 'IN_MATCH', ownerPlayerId: opponentId, matchId: 'match-one', participants: [
      { playerId: opponentId, connectionState: 'CONNECTED' }, { playerId, connectionState: 'CONNECTED' },
    ] };
    const ownCard = {
      cardId: 'own-card', cardDefinitionId: 'ABC123', cardDefinitionVersion: 1,
      ownerPlayerId: playerId, controllerPlayerId: playerId, tapped: true, faceDown: false,
      position: { x: 1, y: 0 }, counters: { plusOnePlusOne: 0, other: 0 },
    };
    const opponentCard = {
      cardId: 'opponent-card', cardDefinitionId: 'DEF123', cardDefinitionVersion: 1,
      ownerPlayerId: opponentId, controllerPlayerId: opponentId, tapped: false, faceDown: false,
      position: { x: 2, y: 0 }, counters: { plusOnePlusOne: 0, other: 0 },
    };
    const zoneTypes = ['LIBRARY', 'HAND', 'GRAVEYARD', 'EXILE', 'SIDEBOARD'] as const;
    const zones = [
      ...[playerId, opponentId].flatMap((ownerPlayerId) => zoneTypes.map((type) => ({ zoneId: `${ownerPlayerId}-${type}`, type, ownerPlayerId, cards: [] }))),
      { zoneId: 'battlefield', type: 'BATTLEFIELD', ownerPlayerId: null, cards: [ownCard, opponentCard] },
    ];
    const gameStateView = {
      gameId: 'game-one', matchId: 'match-one', status: 'PLAYING', turnNumber: 1, activePlayerId: playerId,
      phase: 'BEGINNING', step: 'UNTAP', sequence: 0,
      players: [{ playerId: opponentId, life: 20 }, { playerId, life: 20 }], zones,
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

    const battlefield = host.querySelector<HTMLElement>('.battlefield');
    expect(battlefield?.classList.contains('opponent-perspective')).toBe(true);
    const ownTile = host.querySelector<HTMLButtonElement>('[aria-label="ABC123"]');
    const opponentTile = host.querySelector<HTMLButtonElement>('[aria-label="DEF123"]');
    expect(ownTile?.classList.contains('tapped')).toBe(true);
    expect(ownTile?.style.getPropertyValue('--card-rotation')).toBe('90deg');
    expect(opponentTile?.style.getPropertyValue('--card-rotation')).toBe('0deg');

    const storedData = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: 'all',
      setData: (type: string, value: string) => storedData.set(type, value),
      getData: (type: string) => storedData.get(type) ?? '',
    };
    const dragStart = new Event('dragstart', { bubbles: true });
    Object.defineProperty(dragStart, 'dataTransfer', { value: dataTransfer });
    await act(async () => { ownTile!.dispatchEvent(dragStart); });
    const rect = { left: 0, top: 0, right: 1152, bottom: 380, width: 1152, height: 380, x: 0, y: 0, toJSON: () => ({}) };
    battlefield!.getBoundingClientRect = () => rect as DOMRect;
    Object.defineProperties(battlefield, {
      scrollWidth: { configurable: true, value: 1152 },
      scrollHeight: { configurable: true, value: 380 },
    });
    const drop = new Event('drop', { bubbles: true });
    Object.defineProperties(drop, {
      dataTransfer: { value: dataTransfer },
      clientX: { value: 200 },
      clientY: { value: 100 },
    });
    await act(async () => { battlefield!.dispatchEvent(drop); });
    expect(MockWebSocket.instances[0]?.sent).toContainEqual(expect.objectContaining({
      type: 'MoveCardPosition',
      payload: { cardId: 'own-card', position: { x: 6, y: 1 } },
    }));
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
