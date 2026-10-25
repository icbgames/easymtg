import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, DragEvent, MouseEvent } from 'react';
import { GameStateViewSchema, type GameStateView, type GameCardView } from '@easymtg/game/view';
import {
  ServerMessageSchema, type CardDefinitionVersion, type CardDefinitionVersionWithStatus,
} from '@easymtg/shared';

type DeckSummary = { id: string; name: string; mainboardCount: number; sideboardCount: number; updatedAt: string };
type Deck = { id: string; name: string; mainboard: string[]; sideboard: string[]; updatedAt: string };
type PlayerInfo = { playerId: string; connectionState: 'CONNECTED' | 'DISCONNECTED' };
type Room = { roomId: string; status: 'WAITING' | 'IN_MATCH'; ownerPlayerId: string; participants: PlayerInfo[]; matchId?: string };
type Composition = { mainboard: string[]; sideboard: string[]; confirmed: boolean; opponentConfirmed: boolean };
type CurrentRoom = { room: Room | null; playerId?: string; selectedDeckId?: string; nextGameDeck?: Composition };
type Match = { matchId: string; status: 'ACTIVE' | 'ENDED'; currentGameNumber: number; activeGameId?: string };
type CardMeta = CardDefinitionVersion & { status?: 'ENABLED' | 'DISABLED' };
type LogEntry = { id: string; text: string; tone?: 'error' | 'notice' };
type ApiError = Error & { code?: string; status?: number };

const FALLBACK_IMAGE = '/card-placeholder.svg';
const BACK_IMAGE = '/card-back.svg';
const API = '';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    credentials: 'same-origin',
    ...init,
    headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers },
  });
  const data: unknown = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  if (!response.ok) {
    const errorData = data as { error?: { code?: string; message?: string } } | undefined;
    const error = new Error(errorData?.error?.message ?? `Request failed (${response.status}).`) as ApiError;
    error.code = errorData?.error?.code;
    error.status = response.status;
    throw error;
  }
  return data as T;
}

function messageForError(error: unknown) {
  if (!(error instanceof Error)) return '処理に失敗しました。';
  const apiError = error as ApiError;
  const labels: Record<string, string> = {
    UNAUTHENTICATED: 'セッションが切れました。ページを再読み込みしてください。',
    DECK_INVALID: 'デッキ条件を満たしていません。Mainboardは60枚以上、Sideboardは15枚以下にしてください。',
    DECK_NOT_FOUND: 'デッキが見つかりません。',
    DECK_IN_USE: 'Roomで使用中のデッキは削除できません。',
    CARD_UNAVAILABLE: '使用できないカードが含まれています。',
    ROOM_NOT_FOUND: 'Roomが見つかりません。',
    ROOM_FULL: 'Roomは満員です。',
    ACTIVE_ROOM_EXISTS: 'すでに参加中のRoomがあります。',
    FORBIDDEN: 'この操作を行う権限がありません。',
    PLAYERS_NOT_READY: '双方が次のGame用構成を確定してから開始してください。',
    GAME_STILL_ACTIVE: '進行中のGameが終了してから操作してください。',
    INVALID_AMOUNT: '変更量が無効です。',
  };
  return labels[apiError.code ?? ''] ?? error.message;
}

function uniqueIds(values: string[]) { return [...new Set(values)]; }
function countCards(values: string[]) {
  const counts = new Map<string, number>();
  for (const id of values) counts.set(id, (counts.get(id) ?? 0) + 1);
  return [...counts.entries()].map(([id, count]) => ({ id, count }));
}
function removeOne(values: string[], id: string) {
  const copy = [...values];
  const index = copy.indexOf(id);
  if (index >= 0) copy.splice(index, 1);
  return copy;
}

export default function App() {
  const [roomData, setRoomData] = useState<CurrentRoom>({ room: null });
  const [match, setMatch] = useState<Match | null>(null);
  const [game, setGame] = useState<GameStateView | null>(null);
  const [decks, setDecks] = useState<DeckSummary[]>([]);
  const [screen, setScreen] = useState<'home' | 'deck-list' | 'deck-editor'>('home');
  const [editingDeck, setEditingDeck] = useState<Deck | null>(null);
  const [newDeck, setNewDeck] = useState(false);
  const [cardMeta, setCardMeta] = useState<Record<string, CardMeta>>({});
  const [connected, setConnected] = useState(false);
  const [connectionLabel, setConnectionLabel] = useState('接続しています');
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [viewState, setViewState] = useState<unknown>(null);
  const [error, setError] = useState('');
  const [roomEnded, setRoomEnded] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const playerIdRef = useRef<string | null>(null);
  const syncCursorRef = useRef<{ gameId: string; sequence: number } | null>(null);

  const pushLog = useCallback((text: string, tone?: LogEntry['tone']) => {
    setLogs((existing) => [...existing.slice(-99), { id: crypto.randomUUID(), text, tone }]);
  }, []);

  const refreshRoom = useCallback(async () => {
    const current = await request<CurrentRoom>('/api/rooms/current');
    setRoomData(current);
    playerIdRef.current = current.playerId ?? null;
    if (!current.room) setMatch(null);
    return current;
  }, []);

  const refreshDecks = useCallback(async () => {
    const result = await request<DeckSummary[]>('/api/decks');
    setDecks(result);
  }, []);

  const refreshGame = useCallback(async (expectedGameId?: string) => {
    const result = await request<{ game: { gameId: string; sequence: number; gameStateView: unknown } | null }>('/api/rooms/current/game-state');
    if (!result.game) {
      if (expectedGameId) throw new Error('The active Game is not available for synchronization.');
      setGame(null);
      syncCursorRef.current = null;
      return null;
    }
    const parsed = GameStateViewSchema.safeParse(result.game.gameStateView);
    if (!parsed.success || parsed.data.gameId !== result.game.gameId || parsed.data.sequence !== result.game.sequence ||
      (expectedGameId !== undefined && expectedGameId !== result.game.gameId)) {
      throw new Error('The Game synchronization response is inconsistent.');
    }
    const cursor = syncCursorRef.current;
    if (cursor?.gameId === result.game.gameId && cursor.sequence > result.game.sequence) return cursor;
    setGame(parsed.data);
    syncCursorRef.current = { gameId: result.game.gameId, sequence: result.game.sequence };
    await refreshCardMeta(parsed.data, setCardMeta);
    return syncCursorRef.current;
  }, []);

  useEffect(() => {
    let mounted = true;
    void Promise.all([request<CurrentRoom>('/api/rooms/current'), request<DeckSummary[]>('/api/decks')])
      .then(([current, deckList]) => {
        if (!mounted) return;
        setRoomData(current);
        playerIdRef.current = current.playerId ?? null;
        setDecks(deckList);
      })
      .catch((cause: unknown) => { if (mounted) setError(messageForError(cause)); });
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    let delay = 1000;
    let eventTail = Promise.resolve();
    const connect = () => {
      if (stopped) return;
      setConnectionLabel('接続しています');
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
      socketRef.current = socket;
      socket.addEventListener('open', () => {
        delay = 1000;
        setConnected(true);
        setConnectionLabel('接続中');
        const cursor = syncCursorRef.current;
        socket.send(JSON.stringify({
          type: 'Hello', protocolVersion: 1,
          lastGameId: cursor?.gameId ?? null, lastSequence: cursor?.sequence ?? null,
        }));
        void refreshRoom().catch(() => undefined);
      });
      socket.addEventListener('message', (event) => {
        let raw: unknown;
        try { raw = JSON.parse(String(event.data)); } catch { return; }
        const parsed = ServerMessageSchema.safeParse(raw);
        if (!parsed.success) return;
        const message = parsed.data;
        if (message.type === 'RoomStateSync') {
          void refreshRoom().catch(() => undefined);
          return;
        }
        if (message.type === 'MatchStateSync') {
          setMatch(message.match);
          if (message.match?.activeGameId) {
            void refreshGame(message.match.activeGameId).catch((cause: unknown) => setError(messageForError(cause)));
          } else {
            setGame(null);
            syncCursorRef.current = null;
          }
          return;
        }
        if (message.type === 'InitialState') {
          const view = GameStateViewSchema.safeParse(message.gameStateView);
          if (!view.success || view.data.gameId !== message.gameId || view.data.sequence !== message.sequence) {
            socket.close(4000, 'Game synchronization required.');
            return;
          }
          const cursor = syncCursorRef.current;
          if (cursor?.gameId === message.gameId && message.sequence < cursor.sequence) {
            socket.close(4000, 'Game synchronization required.');
            return;
          }
          setGame(view.data);
          syncCursorRef.current = { gameId: message.gameId, sequence: message.sequence };
          void refreshCardMeta(view.data, setCardMeta);
          return;
        }
        if (message.type === 'GameEvent') {
          eventTail = eventTail.then(async () => {
            const cursor = syncCursorRef.current;
            if (!cursor || cursor.gameId !== message.gameId) {
              socket.close(4000, 'Game synchronization required.');
              return;
            }
            if (message.sequence <= cursor.sequence) return;
            if (message.sequence !== cursor.sequence + 1) {
              socket.close(4000, 'Game sequence gap.');
              return;
            }
            pushLog(describeGameEvent(message));
            if (message.eventType === 'ConcedeApplied') return;
            const refreshed = await refreshGame(message.gameId);
            if (!refreshed || refreshed.sequence < message.sequence) {
              socket.close(4000, 'Game synchronization required.');
            }
          }).catch((cause: unknown) => {
            setError(messageForError(cause));
            socket.close(4000, 'Game synchronization failed.');
          });
          return;
        }
        if (message.type === 'ViewStatePrivate' || message.type === 'ViewStateSync') {
          const payload = message.payload as { viewerPlayerId?: string; cards?: unknown[] };
          if (payload.viewerPlayerId === playerIdRef.current && Array.isArray(payload.cards)) setViewState(payload);
          return;
        }
        if (message.type === 'ViewStateEnded') {
          const endedViewId = (message.payload as { viewId?: string }).viewId;
          setViewState((previous: unknown) => (previous as { viewId?: string } | null)?.viewId === endedViewId ? null : previous);
          return;
        }
        if (message.type === 'CommandResult' && !message.success) {
          pushLog(`操作に失敗しました: ${message.errorCode ?? 'INTERNAL_ERROR'}`, 'error');
          return;
        }
        if (message.type === 'PlayerConnected') {
          pushLog(`${message.playerId === playerIdRef.current ? '自分' : '対戦相手'}が接続しました。`, 'notice');
          void refreshRoom().catch(() => undefined);
          return;
        }
        if (message.type === 'PlayerDisconnected') {
          pushLog(`${message.playerId === playerIdRef.current ? '自分' : '対戦相手'}が切断しました。`, 'notice');
          void refreshRoom().catch(() => undefined);
          return;
        }
        if (message.type === 'GameStarted') {
          pushLog(`Game ${message.gameNumber} を開始しました。`, 'notice');
          setRoomEnded(false);
          syncCursorRef.current = null;
          void refreshRoom().catch(() => undefined);
          void refreshGame(message.gameId).catch((cause: unknown) => setError(messageForError(cause)));
          return;
        }
        if (message.type === 'GameEnded') {
          pushLog(`Game ${message.gameNumber} が終了しました。`, 'notice');
          void refreshRoom().catch(() => undefined);
          setGame(null);
          if (syncCursorRef.current?.gameId === message.gameId) syncCursorRef.current = null;
          return;
        }
        if (message.type === 'MatchEnded') {
          pushLog('Matchが終了しました。勝敗判定は行いません。', 'notice');
          setRoomEnded(true);
          setGame(null);
          setMatch(null);
          syncCursorRef.current = null;
          void refreshRoom().catch(() => undefined);
        }
      });
      socket.addEventListener('close', () => {
        setConnected(false);
        setConnectionLabel('再接続しています');
        if (!stopped) {
          timer = window.setTimeout(connect, delay + Math.floor(Math.random() * Math.min(delay, 1000)));
          delay = Math.min(delay * 2, 30_000);
        }
      });
      socket.addEventListener('error', () => socket.close());
    };
    connect();
    return () => { stopped = true; if (timer !== undefined) window.clearTimeout(timer); socketRef.current?.close(); };
  }, [pushLog, refreshGame, refreshRoom]);

  useEffect(() => {
    if (!match || match.status !== 'ACTIVE' || match.activeGameId || !roomData.room) return;
    const poll = window.setInterval(() => { void refreshRoom().catch(() => undefined); }, 2000);
    return () => window.clearInterval(poll);
  }, [match, refreshRoom, roomData.room]);

  const sendCommand = useCallback((type: string, payload?: unknown) => {
    if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) {
      setError('Serverに接続していません。再接続を待ってください。');
      return;
    }
    socketRef.current.send(JSON.stringify({ type, commandId: crypto.randomUUID(), ...(payload === undefined ? {} : { payload }) }));
  }, []);

  const execute = async (action: () => Promise<unknown>) => {
    setError('');
    try { await action(); }
    catch (cause) { setError(messageForError(cause)); }
  };

  const openEditor = async (deckId?: string) => {
    setError('');
    if (deckId) {
      await execute(async () => {
        const deck = await request<Deck>(`/api/decks/${encodeURIComponent(deckId)}`);
        setEditingDeck(deck);
        setNewDeck(false);
        setScreen('deck-editor');
      });
    } else {
      setEditingDeck({ id: '', name: '', mainboard: [], sideboard: [], updatedAt: new Date().toISOString() });
      setNewDeck(true);
      setScreen('deck-editor');
    }
  };

  const currentRoom = roomData.room;
  const currentPlayer = currentRoom?.participants.find(({ playerId }) => playerId === roomData.playerId);
  const opponent = currentRoom?.participants.find(({ playerId }) => playerId !== roomData.playerId);
  const waitingForOpponent = currentRoom?.status === 'WAITING' || (currentRoom?.status === 'IN_MATCH' && !game && !roomData.nextGameDeck && !roomEnded);

  if (screen === 'deck-editor' && editingDeck) return (
    <DeckEditor
      initial={editingDeck} isNew={newDeck} onCancel={() => setScreen('deck-list')}
      onSaved={async () => { await refreshDecks(); setScreen('deck-list'); }}
      onError={(text) => setError(text)}
    />
  );

  if (screen === 'deck-list') return (
    <main className="page-shell">
      <Header connected={connected} label={connectionLabel} onHome={() => setScreen('home')} />
      <section className="panel deck-library">
        <div className="section-heading"><div><p className="eyebrow">MY DECKS</p><h1>デッキ</h1></div><button className="primary" onClick={() => void openEditor()}>＋ 新しいデッキ</button></div>
        {decks.length === 0 ? <Empty text="保存済みのデッキはありません。" /> : <div className="deck-list">{decks.map((deck) => <article className="deck-row" key={deck.id}>
          <div><h2>{deck.name}</h2><p>Mainboard {deck.mainboardCount}枚 ・ Sideboard {deck.sideboardCount}枚</p><small>更新 {new Date(deck.updatedAt).toLocaleString()}</small></div>
          <div className="button-row"><button onClick={() => void openEditor(deck.id)}>編集</button><button className="danger" onClick={() => void execute(async () => { if (window.confirm(`「${deck.name}」を削除しますか？`)) { await request(`/api/decks/${encodeURIComponent(deck.id)}`, { method: 'DELETE' }); await refreshDecks(); } })}>削除</button></div>
        </article>)}</div>}
      </section>
      {error && <ErrorBanner text={error} onClose={() => setError('')} />}
    </main>
  );

  if (game && currentRoom?.status === 'IN_MATCH') return (
    <GameScreen
      game={game} room={currentRoom} playerId={roomData.playerId ?? ''} cardMeta={cardMeta} logs={logs}
      connected={connected} connectionLabel={connectionLabel} sendCommand={sendCommand} refreshGame={() => void refreshGame()}
      onError={(text) => setError(text)} viewState={viewState}
    />
  );

  if (roomData.nextGameDeck && currentRoom?.status === 'IN_MATCH' && match) return (
    <SideboardScreen
      room={currentRoom} playerId={roomData.playerId ?? ''} gameNumber={match.currentGameNumber}
      setup={roomData.nextGameDeck} cardMeta={cardMeta} setCardMeta={setCardMeta}
      onRefresh={refreshRoom} onStart={() => execute(async () => { await request('/api/rooms/current/games/next', { method: 'POST' }); await refreshRoom(); })}
      onConfirm={async (composition) => {
        await request('/api/rooms/current/next-game-deck', { method: 'PUT', body: JSON.stringify(composition) });
        await refreshRoom();
      }}
      onUnconfirm={() => execute(async () => { await request('/api/rooms/current/next-game-deck/confirmation', { method: 'DELETE' }); await refreshRoom(); })}
      onError={(text) => setError(text)} error={error} connected={connected} connectionLabel={connectionLabel}
    />
  );

  if (currentRoom && waitingForOpponent) return (
    <main className="page-shell">
      <Header connected={connected} label={connectionLabel} onHome={() => setScreen('home')} />
      <section className="panel waiting-room">
        <p className="eyebrow">ROOM</p><h1>対戦相手を待っています</h1>
        <p>このRoom IDを対戦相手に共有してください。</p>
        <div className="share-code"><code>{currentRoom.roomId}</code><button onClick={() => void navigator.clipboard?.writeText(currentRoom.roomId)}>Room IDをコピー</button></div>
        <div className="participant-grid">
          <ParticipantCard title="あなた" player={currentPlayer} owner={currentRoom.ownerPlayerId === roomData.playerId} />
          <ParticipantCard title="対戦相手" player={opponent} owner={currentRoom.ownerPlayerId === opponent?.playerId} />
        </div>
        <button onClick={() => void execute(async () => { await request('/api/rooms/current', { method: 'DELETE' }); await refreshRoom(); })}>Roomから退出</button>
      </section>
      {error && <ErrorBanner text={error} onClose={() => setError('')} />}
    </main>
  );

  return (
    <main className="page-shell home-shell">
      <Header connected={connected} label={connectionLabel} onHome={() => setScreen('home')} />
      <section className="hero panel">
        <p className="eyebrow">TABLETOP CARD BATTLE</p>
        <h1>対戦の準備をしましょう</h1>
        <p>デッキを保存し、Room IDを共有して対戦を始められます。</p>
        {roomEnded && <p className="notice">Matchが終了しました。勝敗の判定は行われません。</p>}
        <div className="home-actions">
          <button className="primary" onClick={() => setScreen('deck-list')}>デッキを管理 <span>→</span></button>
          <RoomActions decks={decks} onError={(text) => setError(text)} onSuccess={async () => { await refreshRoom(); await refreshDecks(); }} />
        </div>
      </section>
      {currentRoom && <section className="panel active-room"><h2>参加中のRoomがあります</h2><p>{currentRoom.roomId}</p><button onClick={() => void refreshRoom()}>状態を更新</button></section>}
      {error && <ErrorBanner text={error} onClose={() => setError('')} />}
    </main>
  );
}

async function refreshCardMeta(gameView: GameStateView, set: (update: (previous: Record<string, CardMeta>) => Record<string, CardMeta>) => void) {
  const identifiers = new Map<string, { id: string; version: number }>();
  for (const zone of gameView.zones) for (const card of zone.cards) {
    if ('cardDefinitionId' in card) identifiers.set(`${card.cardDefinitionId}@${card.cardDefinitionVersion}`, { id: card.cardDefinitionId, version: card.cardDefinitionVersion });
  }
  const missing = [...identifiers.entries()].filter(([key]) => !cardMetaCache.has(key));
  await Promise.all(missing.map(async ([key, item]) => {
    try { cardMetaCache.set(key, await request<CardMeta>(`/api/card-definitions/${encodeURIComponent(item.id)}/versions/${item.version}`)); }
    catch { cardMetaCache.set(key, null); }
  }));
  set((previous) => {
    const next = { ...previous };
    for (const [key] of identifiers) { const item = cardMetaCache.get(key); if (item) next[key] = item; }
    return next;
  });
}
const cardMetaCache = new Map<string, CardMeta | null>();

function describeGameEvent(message: { eventType: string; payload: unknown }) {
  const payload = message.payload as { actorPlayerId?: string; commandPayload?: Record<string, unknown> | null };
  const who = payload?.actorPlayerId ? `${payload.actorPlayerId}：` : '';
  const command = message.eventType.replace(/Applied$/u, '');
  const labels: Record<string, string> = {
    MoveCard: 'カードを移動', ReorderCard: 'カードの順番を変更', TapCard: 'カードをタップ', UntapCard: 'カードをアンタップ',
    TurnFaceDown: 'カードを裏向きに', TurnFaceUp: 'カードを表向きに', AddCounter: 'カウンターを追加', RemoveCounter: 'カウンターを削除',
    ChangeController: 'コントローラーを変更', ChangeVisibility: '公開範囲を変更', MoveCardPosition: 'カード位置を変更',
    ChangeLife: 'ライフを変更', ShuffleZone: 'ゾーンをシャッフル', ChangeTurnPosition: 'フェイズ／ステップを変更', EndTurn: 'ターンを終了', Concede: '投了',
  };
  const amount = payload?.commandPayload?.amount;
  return `${who}${labels[command] ?? 'ゲーム状態を更新'}${typeof amount === 'number' ? ` (${amount > 0 ? '+' : ''}${amount})` : ''}`;
}

function Header({ connected, label, onHome }: { connected: boolean; label: string; onHome: () => void }) {
  return <header className="app-header"><button className="brand" onClick={onHome} aria-label="ホームへ戻る"><span className="brand-mark">E</span><span>EasyMTG</span></button><div className={`connection-pill ${connected ? 'online' : ''}`}><i />{label}</div></header>;
}
function Empty({ text }: { text: string }) { return <div className="empty-state">{text}</div>; }
function ErrorBanner({ text, onClose }: { text: string; onClose: () => void }) { return <div className="error-banner" role="alert"><span>{text}</span><button onClick={onClose} aria-label="エラーを閉じる">×</button></div>; }
function ParticipantCard({ title, player, owner }: { title: string; player?: PlayerInfo; owner: boolean }) {
  return <article className="participant-card"><span>{title}</span><strong>{player ? (player.connectionState === 'CONNECTED' ? '接続中' : '切断中') : '未参加'}</strong>{player && <small>{owner ? 'Room owner' : 'Player'}</small>}</article>;
}

function RoomActions({ decks, onError, onSuccess }: { decks: DeckSummary[]; onError: (text: string) => void; onSuccess: () => Promise<void> }) {
  const [mode, setMode] = useState<'create' | 'join' | null>(null);
  const [deckId, setDeckId] = useState(decks[0]?.id ?? '');
  const [roomId, setRoomId] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault(); onError('');
    try {
      if (mode === 'create') await request('/api/rooms', { method: 'POST', body: JSON.stringify({ deckId }) });
      else await request(`/api/rooms/${encodeURIComponent(roomId.trim())}/join`, { method: 'POST', body: JSON.stringify({ deckId }) });
      await onSuccess(); setMode(null);
    } catch (cause) { onError(messageForError(cause)); }
  };
  return <div className="room-action-wrap">
    <div className="button-row"><button onClick={() => { setDeckId((current) => current || decks[0]?.id || ''); setMode('create'); }}>Roomを作成</button><button onClick={() => { setDeckId((current) => current || decks[0]?.id || ''); setMode('join'); }}>Room IDで参加</button></div>
    {mode && <form className="inline-form" onSubmit={(event) => void submit(event)}>
      <div className="form-heading"><strong>{mode === 'create' ? 'Roomを作成' : 'Roomに参加'}</strong><button type="button" className="icon-button" onClick={() => setMode(null)} aria-label="閉じる">×</button></div>
      {mode === 'join' && <label>Room ID<input required value={roomId} onChange={(event) => setRoomId(event.target.value)} placeholder="room-…" /></label>}
      <label>使用するデッキ<select required value={deckId} onChange={(event) => setDeckId(event.target.value)} disabled={decks.length === 0}><option value="">デッキを選択</option>{decks.map((deck) => <option key={deck.id} value={deck.id}>{deck.name} ({deck.mainboardCount}枚)</option>)}</select></label>
      {decks.length === 0 && <p className="field-note">Room参加には保存済みデッキが必要です。</p>}
      <button className="primary" disabled={!deckId}>{mode === 'create' ? 'Roomを作成' : '参加する'}</button>
    </form>}
  </div>;
}

function DeckEditor({ initial, isNew, onCancel, onSaved, onError }: { initial: Deck; isNew: boolean; onCancel: () => void; onSaved: () => Promise<void>; onError: (text: string) => void }) {
  const [name, setName] = useState(initial.name);
  const [mainboard, setMainboard] = useState(initial.mainboard);
  const [sideboard, setSideboard] = useState(initial.sideboard);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CardDefinitionVersionWithStatus[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [busy, setBusy] = useState(false);
  const [existingMeta, setExistingMeta] = useState<Record<string, CardMeta>>({});
  const mainCounts = useMemo(() => countCards(mainboard), [mainboard]);
  const sideCounts = useMemo(() => countCards(sideboard), [sideboard]);
  const unique = useMemo(() => uniqueIds([...mainboard, ...sideboard]), [mainboard, sideboard]);

  useEffect(() => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void request<{ items: CardDefinitionVersionWithStatus[]; totalPages: number }>(`/api/card-definitions?q=${encodeURIComponent(query)}&page=${page}`, { signal: controller.signal })
        .then((data) => { setResults(data.items); setTotalPages(data.totalPages); })
        .catch((cause: unknown) => { if ((cause as { name?: string })?.name !== 'AbortError') onError(messageForError(cause)); });
    }, 300);
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [onError, page, query]);

  useEffect(() => {
    const missing = unique.filter((id) => !results.some((item) => item.cardDefinitionId === id) && !existingMeta[id]);
    if (!missing.length) return;
    let cancelled = false;
    void Promise.all(missing.map(async (id) => {
      try { return [id, await request<CardMeta>(`/api/card-definitions/${encodeURIComponent(id)}`)] as const; }
      catch { return [id, { cardDefinitionId: id, version: 0, englishName: id, frontImageUrl: '', hasBack: false, status: 'DISABLED' as const, rulesData: {}, createdAt: new Date().toISOString() } as CardMeta] as const; }
    })).then((items) => { if (!cancelled) setExistingMeta((previous) => ({ ...previous, ...Object.fromEntries(items) })); });
    return () => { cancelled = true; };
  }, [existingMeta, results, unique]);

  const getMeta = (id: string): CardMeta | undefined => results.find((item) => item.cardDefinitionId === id) ?? existingMeta[id];
  const save = async () => {
    setBusy(true); onError('');
    try {
      const body = JSON.stringify({ name, mainboard, sideboard });
      if (isNew) await request('/api/decks', { method: 'POST', body });
      else await request(`/api/decks/${encodeURIComponent(initial.id)}`, { method: 'PUT', body });
      await onSaved();
    } catch (cause) { onError(messageForError(cause)); }
    finally { setBusy(false); }
  };

  return <main className="page-shell deck-editor-page">
    <header className="app-header"><button className="brand" onClick={onCancel}><span className="brand-mark">E</span><span>デッキ編集</span></button><div className="button-row"><button onClick={onCancel}>キャンセル</button><button className="primary" onClick={() => void save()} disabled={busy || name.trim().length < 1 || name.trim().length > 100 || mainboard.length < 60 || sideboard.length > 15}>{busy ? '保存中…' : '明示的に保存'}</button></div></header>
    <div className="deck-editor-layout">
      <section className="panel card-search-panel">
        <div className="section-heading"><div><p className="eyebrow">CARD CATALOG</p><h1>カードを検索</h1></div><span className="muted">ENABLEDのみ</span></div>
        <label className="search-field"><span className="sr-only">カード名またはIDで検索</span><input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="カード名・Card ID" /><span>⌕</span></label>
        <div className="search-results">{results.map((card) => <article className="search-card" key={card.cardDefinitionId}>
          <img src={card.frontImageUrl} onError={(event) => { event.currentTarget.src = FALLBACK_IMAGE; }} alt="" />
          <div className="search-card-text"><strong>{card.japaneseName ?? card.englishName}</strong><small>{card.englishName} ・ {card.cardDefinitionId}</small></div>
          <div className="add-buttons"><button aria-label={`${card.englishName}をMainboardに追加`} onClick={() => setMainboard((list) => [...list, card.cardDefinitionId])}>M＋</button><button disabled={sideboard.length >= 15} aria-label={`${card.englishName}をSideboardに追加`} onClick={() => setSideboard((list) => [...list, card.cardDefinitionId])}>S＋</button></div>
        </article>)}{results.length === 0 && <Empty text="該当するカードがありません。" />}</div>
        <div className="pager"><button disabled={page <= 1} onClick={() => setPage((n) => n - 1)}>前へ</button><span>{totalPages ? `${page} / ${totalPages}` : '0件'}</span><button disabled={page >= totalPages} onClick={() => setPage((n) => n + 1)}>次へ</button></div>
      </section>
      <section className="panel deck-composition-panel">
        <label className="deck-name-field">デッキ名<input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} placeholder="デッキ名" /></label>
        <BoardEditor title="Mainboard" count={mainboard.length} limit="60枚以上" cards={mainCounts} meta={getMeta} onMinus={(id) => setMainboard((list) => removeOne(list, id))} onPlus={(id) => setMainboard((list) => [...list, id])} />
        <BoardEditor title="Sideboard" count={sideboard.length} limit="0〜15枚" cards={sideCounts} meta={getMeta} onMinus={(id) => setSideboard((list) => removeOne(list, id))} onPlus={(id) => setSideboard((list) => [...list, id])} />
        <p className={`save-rule ${mainboard.length < 60 ? 'warning' : ''}`}>{mainboard.length < 60 ? `Mainboardがあと${60 - mainboard.length}枚必要です。作業内容は保存されません。` : `保存可能です。Mainboard ${mainboard.length}枚 / Sideboard ${sideboard.length}枚`}</p>
      </section>
    </div>
  </main>;
}

function BoardEditor({ title, count, limit, cards, meta, onMinus, onPlus }: { title: string; count: number; limit: string; cards: Array<{ id: string; count: number }>; meta: (id: string) => CardMeta | undefined; onMinus: (id: string) => void; onPlus: (id: string) => void }) {
  const sortedCards = [...cards].sort((a, b) => {
    const aMeta = meta(a.id);
    const bMeta = meta(b.id);
    const aType = typeof aMeta?.rulesData.type === 'string' ? aMeta.rulesData.type : undefined;
    const bType = typeof bMeta?.rulesData.type === 'string' ? bMeta.rulesData.type : undefined;
    if (aType === undefined && bType !== undefined) return 1;
    if (aType !== undefined && bType === undefined) return -1;
    if (aType !== undefined && bType !== undefined) {
      const typeOrder = aType.localeCompare(bType, 'ja', { numeric: true, sensitivity: 'base' });
      if (typeOrder !== 0) return typeOrder;
    }

    const aCost = typeof aMeta?.rulesData.cost === 'number' && Number.isFinite(aMeta.rulesData.cost) ? aMeta.rulesData.cost : undefined;
    const bCost = typeof bMeta?.rulesData.cost === 'number' && Number.isFinite(bMeta.rulesData.cost) ? bMeta.rulesData.cost : undefined;
    if (aCost === undefined && bCost !== undefined) return 1;
    if (aCost !== undefined && bCost === undefined) return -1;
    if (aCost !== undefined && bCost !== undefined) return aCost - bCost;
    return 0;
  });
  return <section className="board-editor"><header><h2>{title}</h2><strong>{count}</strong><small>{limit}</small></header>
    {cards.length === 0 ? <p className="empty-inline">検索結果からカードを追加してください。</p> : <ul>{sortedCards.map(({ id, count: amount }) => {
      const card = meta(id);
      return <li key={id} className={card?.status === 'DISABLED' ? 'disabled-card' : ''}><img src={card?.frontImageUrl || FALLBACK_IMAGE} alt="" onError={(event) => { event.currentTarget.src = FALLBACK_IMAGE; }} /><span className="board-card-name">{card?.japaneseName ?? card?.englishName ?? id}<small>{id}{card?.status === 'DISABLED' ? ' ・ DISABLED（使用不可）' : ''}</small></span><button aria-label={`${card?.englishName ?? id}を1枚減らす`} onClick={() => onMinus(id)}>−</button><b>{amount}</b><button aria-label={`${card?.englishName ?? id}を1枚増やす`} onClick={() => onPlus(id)}>＋</button></li>;
    })}</ul>}
  </section>;
}

function SideboardScreen({ room, playerId, gameNumber, setup, cardMeta, setCardMeta, onRefresh, onStart, onConfirm, onUnconfirm, onError, error, connected, connectionLabel }: {
  room: Room; playerId: string; gameNumber: number; setup: Composition; cardMeta: Record<string, CardMeta>; setCardMeta: (update: (previous: Record<string, CardMeta>) => Record<string, CardMeta>) => void;
  onRefresh: () => Promise<unknown>; onStart: () => void; onConfirm: (composition: { mainboard: string[]; sideboard: string[] }) => Promise<void>; onUnconfirm: () => void; onError: (text: string) => void; error: string; connected: boolean; connectionLabel: string;
}) {
  const [mainboard, setMainboard] = useState(setup.mainboard);
  const [sideboard, setSideboard] = useState(setup.sideboard);
  const [confirmed, setConfirmed] = useState(setup.confirmed);
  const [opponentConfirmed, setOpponentConfirmed] = useState(setup.opponentConfirmed);
  const [busy, setBusy] = useState(false);
  const owner = room.ownerPlayerId === playerId;
  useEffect(() => {
    const ids = uniqueIds([...mainboard, ...sideboard]).filter((id) => !cardMeta[`latest:${id}`]);
    let cancelled = false;
    void Promise.all(ids.map(async (id) => {
      try { const detail = await request<CardMeta>(`/api/card-definitions/${encodeURIComponent(id)}`); return [`latest:${id}`, detail] as const; }
      catch { return [`latest:${id}`, { cardDefinitionId: id, version: 0, englishName: id, frontImageUrl: '', hasBack: false, status: 'DISABLED' as const, rulesData: {}, createdAt: new Date().toISOString() } as CardMeta] as const; }
    })).then((items) => { if (!cancelled && items.length) setCardMeta((prev) => ({ ...prev, ...Object.fromEntries(items) })); });
    return () => { cancelled = true; };
  }, [cardMeta, mainboard, sideboard, setCardMeta]);

  const edit = (from: 'mainboard' | 'sideboard', id: string) => {
    if (confirmed) { setConfirmed(false); onUnconfirm(); }
    if (from === 'mainboard') { setMainboard((list) => removeOne(list, id)); setSideboard((list) => [...list, id]); }
    else { setSideboard((list) => removeOne(list, id)); setMainboard((list) => [...list, id]); }
  };
  const cards = (values: string[], from: 'mainboard' | 'sideboard') => countCards(values).map(({ id, count }) => {
    const meta = cardMeta[`latest:${id}`];
    return <li key={id}><img src={meta?.frontImageUrl || FALLBACK_IMAGE} alt="" onError={(event) => { event.currentTarget.src = FALLBACK_IMAGE; }} /><span>{meta?.japaneseName ?? meta?.englishName ?? id}<small>{id}</small></span><b>{count}</b><button aria-label={`${id}を${from === 'mainboard' ? 'Sideboard' : 'Mainboard'}へ1枚移動`} onClick={() => edit(from, id)}>⇄</button></li>;
  });
  const confirm = async () => {
    setBusy(true); onError('');
    try {
      await onConfirm({ mainboard, sideboard });
      setConfirmed(true); await onRefresh();
    } catch (cause) { onError(messageForError(cause)); }
    finally { setBusy(false); }
  };
  const refreshReady = async () => {
    const result = await request<CurrentRoom>('/api/rooms/current');
    if (result.nextGameDeck) { setConfirmed(result.nextGameDeck.confirmed); setOpponentConfirmed(result.nextGameDeck.opponentConfirmed); }
  };
  useEffect(() => { const timer = window.setInterval(() => { void refreshReady().catch(() => undefined); }, 2000); return () => window.clearInterval(timer); }, []);
  const canConfirm = mainboard.length >= 60 && sideboard.length <= 15;
  return <main className="page-shell sideboard-page">
    <Header connected={connected} label={connectionLabel} onHome={() => void onRefresh()} />
    <section className="panel sideboard-heading"><div><p className="eyebrow">GAME {gameNumber} COMPLETE</p><h1>次のGame用デッキ</h1><p>カード総数を変えず、MainboardとSideboardの間で調整します。保存済みデッキは変更されません。</p></div>
      <div className="ready-status"><div className={confirmed ? 'ready yes' : 'ready'}><i />あなた：{confirmed ? '確定済み' : '編集中'}</div><div className={opponentConfirmed ? 'ready yes' : 'ready'}><i />対戦相手：{opponentConfirmed ? '確定済み' : '編集中'}</div></div></section>
    <div className="sideboard-boards"><section className="panel board-editor"><header><h2>Mainboard</h2><strong>{mainboard.length}</strong><small>60枚以上</small></header><ul>{cards(mainboard, 'mainboard')}</ul></section><section className="panel board-editor"><header><h2>Sideboard</h2><strong>{sideboard.length}</strong><small>0〜15枚</small></header><ul>{cards(sideboard, 'sideboard')}</ul></section></div>
    <footer className="sideboard-footer panel"><p className={canConfirm ? '' : 'warning'}>{canConfirm ? '内容を確認して確定してください。' : '枚数条件を満たしていません。'}</p><button className="primary" disabled={!canConfirm || busy || confirmed} onClick={() => void confirm()}>{confirmed ? '確定済み' : 'この構成で確定'}</button>
      {owner && <button className="start-game" disabled={!confirmed || !opponentConfirmed || busy} onClick={onStart}>双方の確定後にGameを開始</button>}
      {!owner && <span className="muted">Room ownerが双方の確定を確認してGameを開始します。</span>}
    </footer>
    {error && <ErrorBanner text={error} onClose={() => onError('')} />}
  </main>;
}

function GameScreen({ game, room, playerId, cardMeta, logs, connected, connectionLabel, sendCommand, refreshGame, onError, viewState }: {
  game: GameStateView; room: Room; playerId: string; cardMeta: Record<string, CardMeta>; logs: LogEntry[]; connected: boolean; connectionLabel: string;
  sendCommand: (type: string, payload?: unknown) => void; refreshGame: () => void; onError: (text: string) => void;
  viewState: unknown;
}) {
  const [context, setContext] = useState<{ cardId: string; x: number; y: number } | null>(null);
  const [selectedCard, setSelectedCard] = useState<string | null>(null);
  const viewPrivate = useMemo(() => {
    if (!viewState || typeof viewState !== 'object') return null;
    const payload = viewState as Partial<{ viewId: string; sourceZoneId: string; viewType: string; viewedCardIds: string[]; selectedCardIds: string[]; cards: GameCardView[] }>;
    return typeof payload.viewId === 'string' && Array.isArray(payload.cards) && Array.isArray(payload.viewedCardIds)
      ? payload as { viewId: string; sourceZoneId: string; viewType: string; viewedCardIds: string[]; selectedCardIds: string[]; cards: GameCardView[] }
      : null;
  }, [viewState]);
  const battlefield = game.zones.find(({ type }) => type === 'BATTLEFIELD');
  const localPlayer = game.players.find(({ playerId: id }) => id === playerId);
  const opponent = game.players.find(({ playerId: id }) => id !== playerId);
  const localReady = room.participants.every(({ connectionState }) => connectionState === 'CONNECTED');
  const cardIn = (zoneId: string) => game.zones.find(({ zoneId: id }) => id === zoneId);
  const playerZone = (type: string, owner: string) => game.zones.find((zone) => zone.type === type && zone.ownerPlayerId === owner);
  const identified = (card: GameCardView): card is GameCardView & { cardId: string; cardDefinitionId: string; cardDefinitionVersion: number } => 'cardId' in card;
  const metaFor = (card: GameCardView) => identified(card) ? cardMeta[`${card.cardDefinitionId}@${card.cardDefinitionVersion}`] : undefined;
  const issue = (type: string, payload?: unknown) => { if (!localReady) { onError('対戦相手の再接続を待っています。'); return; } sendCommand(type, payload); };
  const autoPosition = () => {
    const taken = new Set((battlefield?.cards ?? []).flatMap((card) => card.position ? [`${card.position.x},${card.position.y}`] : []));
    for (let y = 0; ; y += 1) for (let x = 0; x < 8; x += 1) if (!taken.has(`${x},${y}`)) return { x, y };
  };
  const move = (cardId: string, destinationZoneId: string, position?: { x: number; y: number }) => {
    issue('MoveCard', { cardId, destinationZoneId, ...(position ? { position } : {}) });
    setContext(null);
  };
  const positionFromDrop = (event: DragEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.floor((event.clientX - rect.left + event.currentTarget.scrollLeft) / 144)), y: Math.max(0, Math.floor((event.clientY - rect.top + event.currentTarget.scrollTop) / 190)) };
  };
  const startDrag = (event: DragEvent, card: GameCardView) => { if (identified(card)) event.dataTransfer.setData('text/easymtg-card', card.cardId); };
  const dropZone = (event: DragEvent, zoneId: string) => {
    event.preventDefault(); const cardId = event.dataTransfer.getData('text/easymtg-card');
    if (!cardId) return;
    const target = cardIn(zoneId);
    if (target?.type === 'BATTLEFIELD') move(cardId, zoneId, positionFromDrop(event as DragEvent<HTMLDivElement>));
    else if (target?.type === 'LIBRARY') issue('MoveCard', { cardId, destinationZoneId: zoneId, insertIndex: 0 });
    else move(cardId, zoneId);
  };
  const openZone = (zone: GameStateView['zones'][number]) => {
    if (zone.type === 'HAND' && zone.ownerPlayerId !== playerId) return;
    const viewType = zone.type === 'LIBRARY' ? 'LIBRARY_SEARCH' : 'ZONE_VIEW';
    issue('StartView', { sourceZoneId: zone.zoneId, viewType });
  };
  const renderCard = (card: GameCardView, opts: { className?: string; compact?: boolean; key?: string; viewMode?: boolean } = {}) => {
    const known = identified(card);
    const meta = metaFor(card);
    const src = card.faceDown ? (meta?.backImageUrl || BACK_IMAGE) : (meta?.frontImageUrl || FALLBACK_IMAGE);
    const cardId = known ? card.cardId : undefined;
    const title = known ? (meta?.japaneseName ?? meta?.englishName ?? card.cardDefinitionId) : '非公開カード';
    return <button key={cardId ?? opts.key ?? `${opts.className}-${card.ownerPlayerId}-${card.faceDown}`} className={`card-tile ${opts.className ?? ''} ${card.tapped ? 'tapped' : ''} ${selectedCard === cardId ? 'selected' : ''} ${!known ? 'unknown' : ''}`} style={card.position && opts.className === 'battle-card' ? { left: `${card.position.x * 144}px`, top: `${card.position.y * 190}px` } : undefined}
      draggable={known && localReady} onDragStart={(event) => startDrag(event, card)} onDoubleClick={() => { if (known) issue(card.tapped ? 'UntapCard' : 'TapCard', { cardId: card.cardId }); }}
      onClick={() => { if (opts.viewMode && known && viewPrivate) issue('SelectViewCard', { viewId: viewPrivate.viewId, cardId: card.cardId, selected: !viewPrivate.selectedCardIds.includes(card.cardId) }); else { setSelectedCard(cardId ?? null); if (known && opts.className !== 'battle-card') setContext({ cardId: card.cardId, x: 0, y: 0 }); } }}
      onContextMenu={(event: MouseEvent) => { event.preventDefault(); if (known) setContext({ cardId: card.cardId, x: Math.min(event.clientX, window.innerWidth - 300), y: Math.min(event.clientY, window.innerHeight - 400) }); }}
      aria-label={title} title={title}>
      <img src={src} alt="" onError={(event) => { event.currentTarget.src = card.faceDown ? BACK_IMAGE : FALLBACK_IMAGE; }} />
      {opts.compact && <span>{known ? (meta?.japaneseName ?? meta?.englishName ?? card.cardDefinitionId) : '非公開'}</span>}
      {card.counters.plusOnePlusOne > 0 && <b className="counter-badge">+1/+1 {card.counters.plusOnePlusOne}</b>}
      {card.counters.other > 0 && <b className="counter-badge other">他 {card.counters.other}</b>}
      {known && <small className="card-menu-hint">⋯</small>}
    </button>;
  };
  const localHand = playerZone('HAND', playerId);
  const opponentId = game.players.find(({ playerId: id }) => id !== playerId)?.playerId ?? '';
  const opponentHand = playerZone('HAND', opponentId);
  const contextCard = context ? game.zones.flatMap(({ cards }) => cards).find((card) => identified(card) && card.cardId === context.cardId) : undefined;
  const contextKnown = contextCard && identified(contextCard) ? contextCard : undefined;
  const allowedZones = contextKnown ? game.zones.filter((zone) => zone.type !== 'BATTLEFIELD' && zone.ownerPlayerId === contextKnown.ownerPlayerId) : [];

  return <main className="battle-layout">
    <aside className="game-left">
      <Header connected={connected} label={connectionLabel} onHome={() => undefined} />
      <PlayerRail title="対戦相手" player={opponent} ownerId={opponentId} game={game} cardMeta={cardMeta} own={false} disabled={!localReady} onLife={(amount) => issue('ChangeLife', { amount })} onZone={openZone} onDropCard={dropZone} />
      <PlayerRail title="自分" player={localPlayer} ownerId={playerId} game={game} cardMeta={cardMeta} own disabled={!localReady} onLife={(amount) => issue('ChangeLife', { amount })} onZone={openZone} onDropCard={dropZone} />
    </aside>
    <section className="game-center">
      <header className="game-topbar"><div><p className="eyebrow">MATCH {room.matchId ?? ''}</p><strong>Game state is server controlled</strong></div><div className="turn-controls"><span>Turn {game.turnNumber} ・ {game.phase}{game.step ? ` / ${game.step}` : ''}</span><button disabled={!localReady} onClick={() => issue('EndTurn')}>ターン終了</button><button className="danger" disabled={!localReady} onClick={() => { if (window.confirm('このGameから投了しますか？')) issue('Concede'); }}>投了</button></div></header>
      {!localReady && <div className="disconnect-banner" role="status">対戦相手の再接続を待っています。ゲーム操作は一時停止中です。</div>}
      <PlayerHand label="対戦相手の手札" cards={opponentHand?.cards ?? []} renderCard={renderCard} faceDown />
      <div className="phase-track" aria-label="フェイズとステップ">
        {phaseSteps.map(({ phase, step, label }) => <button key={`${phase}-${step ?? 'none'}`} className={game.phase === phase && game.step === step ? 'current' : ''} disabled={!localReady || game.activePlayerId !== playerId} onClick={() => issue('ChangeTurnPosition', { phase, step })}>{label}</button>)}
      </div>
      <div className="battlefield-frame"><div className="battlefield" onDragOver={(event) => event.preventDefault()} onDrop={(event) => battlefield && dropZone(event, battlefield.zoneId)}>
        <div className="battle-grid" aria-hidden="true" />
        {(battlefield?.cards ?? []).map((card) => renderCard(card, { className: 'battle-card' }))}
      </div></div>
      <PlayerHand label="自分の手札" cards={localHand?.cards ?? []} renderCard={renderCard} onDropCard={(event) => localHand && dropZone(event, localHand.zoneId)} />
      <div className="game-bottom-controls"><button disabled={!localReady} onClick={() => { const library = playerZone('LIBRARY', playerId); if (library) issue('ShuffleZone', { zoneId: library.zoneId }); }}>ライブラリーをシャッフル</button><button disabled={!localReady || !localHand || !playerZone('LIBRARY', playerId)?.cards.length} onClick={() => { const library = playerZone('LIBRARY', playerId); if (library) issue('StartView', { sourceZoneId: library.zoneId, viewType: 'LIBRARY_TOP', count: 1 }); }}>1枚ドロー</button></div>
    </section>
    <aside className="system-log"><div className="log-heading"><p className="eyebrow">LIVE LOG</p><h2>システムメッセージ</h2></div><div className="log-list" aria-live="polite">{logs.map((entry) => <p key={entry.id} className={entry.tone ?? ''}>{entry.text}</p>)}{logs.length === 0 && <p className="muted">プレイヤーの操作や対戦状況がここに表示されます。</p>}</div><div className="log-connection"><i className={localReady ? 'ok' : ''} />{localReady ? '両プレイヤー接続中' : '再接続待ち'}</div></aside>
    {context && contextKnown && <div className="context-backdrop" onMouseDown={() => setContext(null)}><div className="context-menu" style={{ left: context.x, top: context.y }} onMouseDown={(event) => event.stopPropagation()} role="menu" aria-label="カード操作">
      <fieldset className="command-set" disabled={!localReady}><strong>{cardMeta[`${contextKnown.cardDefinitionId}@${contextKnown.cardDefinitionVersion}`]?.japaneseName ?? contextKnown.cardDefinitionId}</strong>
      <button role="menuitem" onClick={() => move(contextKnown.cardId, battlefield?.zoneId ?? '', autoPosition())}>Battlefieldへ自動配置</button>
      {allowedZones.map((zone) => <button role="menuitem" key={zone.zoneId} onClick={() => move(contextKnown.cardId, zone.zoneId)}>{zoneLabel(zone.type)}へ移動</button>)}
      {game.zones.find((zone) => zone.cards.some((card) => identified(card) && card.cardId === contextKnown.cardId))?.type === 'BATTLEFIELD' && <>
        <button role="menuitem" onClick={() => issue(contextKnown.tapped ? 'UntapCard' : 'TapCard', { cardId: contextKnown.cardId })}>{contextKnown.tapped ? 'アンタップ' : 'タップ'}</button>
        <button role="menuitem" onClick={() => issue(contextKnown.faceDown ? 'TurnFaceUp' : 'TurnFaceDown', { cardId: contextKnown.cardId })}>{contextKnown.faceDown ? '表向きにする' : '裏向きにする'}</button>
        <button role="menuitem" onClick={() => issue('AddCounter', { cardId: contextKnown.cardId, counterType: 'PLUS_ONE_PLUS_ONE', amount: 1 })}>+1/+1カウンターを追加</button>
        <button role="menuitem" disabled={contextKnown.counters.plusOnePlusOne < 1} onClick={() => issue('RemoveCounter', { cardId: contextKnown.cardId, counterType: 'PLUS_ONE_PLUS_ONE', amount: 1 })}>+1/+1カウンターを削除</button>
        <button role="menuitem" onClick={() => issue('ChangeController', { cardId: contextKnown.cardId, controllerPlayerId: contextKnown.controllerPlayerId === playerId ? opponentId : playerId })}>コントローラーを切替</button>
        <button role="menuitem" onClick={() => issue('ChangeVisibility', { cardId: contextKnown.cardId, visibility: 'PUBLIC' })}>全員に公開</button>
        <button role="menuitem" onClick={() => issue('ChangeVisibility', { cardId: contextKnown.cardId, visibility: 'CONTROLLER_ONLY' })}>Controllerのみに公開</button>
        <button role="menuitem" onClick={() => issue('ChangeVisibility', { cardId: contextKnown.cardId, visibility: 'HIDDEN' })}>非公開にする</button>
      </>}
      </fieldset><button role="menuitem" onClick={() => setContext(null)}>閉じる</button>
    </div></div>}
    {viewPrivate && <div className="modal-backdrop"><section className="modal-panel view-modal"><header><div><p className="eyebrow">PRIVATE VIEW</p><h2>{viewPrivate.viewType === 'LIBRARY_TOP' ? 'ライブラリー上' : zoneLabel(cardIn(viewPrivate.sourceZoneId)?.type ?? 'ZONE')}</h2></div><button className="modal-close" onClick={() => issue('CancelView', { viewId: viewPrivate.viewId })}>閉じる</button></header><p className="muted">カードを選択し、移動先を選んで確定します。</p><div className="zone-modal-cards">{viewPrivate.cards.map((card, index) => <div className={`view-card ${viewPrivate.selectedCardIds.includes((card as GameCardView & {cardId?: string}).cardId ?? '') ? 'selected' : ''}`} key={(card as GameCardView & {cardId?: string}).cardId ?? `hidden-${index}`}>{renderCard(card, { compact: true, viewMode: true, key: `view-${index}` })}<div className="button-row"><button disabled={index === 0} onClick={() => { const ids = [...viewPrivate.viewedCardIds]; [ids[index - 1], ids[index]] = [ids[index]!, ids[index - 1]!]; issue('ReorderViewCards', { viewId: viewPrivate.viewId, cardIds: ids }); }}>↑</button><button disabled={index === viewPrivate.viewedCardIds.length - 1} onClick={() => { const ids = [...viewPrivate.viewedCardIds]; [ids[index + 1], ids[index]] = [ids[index]!, ids[index + 1]!]; issue('ReorderViewCards', { viewId: viewPrivate.viewId, cardIds: ids }); }}>↓</button></div></div>)}</div><footer className="button-row"><button onClick={() => issue('ConfirmView', { viewId: viewPrivate.viewId, moves: [] })}>並び順を確定</button>{viewPrivate.selectedCardIds.length > 0 && <><button className="primary" disabled={!localHand} onClick={() => localHand && issue('ConfirmView', { viewId: viewPrivate.viewId, moves: viewPrivate.selectedCardIds.map((cardId, index) => ({ cardId, destinationZoneId: localHand.zoneId, insertIndex: index })) })}>選択カードを手札へ</button>{battlefield && <button onClick={() => issue('ConfirmView', { viewId: viewPrivate.viewId, moves: viewPrivate.selectedCardIds.map((cardId, index) => ({ cardId, destinationZoneId: battlefield.zoneId, position: { x: index, y: 0 } })) })}>戦場へ移動</button>}</>}</footer></section></div>}
    <button className="hidden" onClick={refreshGame} aria-hidden="true" tabIndex={-1}>更新</button>
  </main>;
}

const phaseSteps: Array<{ phase: GameStateView['phase']; step: GameStateView['step']; label: string }> = [
  { phase: 'BEGINNING', step: 'UNTAP', label: 'アンタップ' }, { phase: 'BEGINNING', step: 'UPKEEP', label: 'アップキープ' }, { phase: 'BEGINNING', step: 'DRAW', label: 'ドロー' },
  { phase: 'PRECOMBAT_MAIN', step: null, label: '第1メイン' }, { phase: 'COMBAT', step: 'BEGIN_COMBAT', label: '戦闘開始' }, { phase: 'COMBAT', step: 'DECLARE_ATTACKERS', label: '攻撃指定' },
  { phase: 'COMBAT', step: 'DECLARE_BLOCKERS', label: 'ブロック指定' }, { phase: 'COMBAT', step: 'COMBAT_DAMAGE', label: '戦闘ダメージ' }, { phase: 'COMBAT', step: 'END_COMBAT', label: '戦闘終了' },
  { phase: 'POSTCOMBAT_MAIN', step: null, label: '第2メイン' }, { phase: 'ENDING', step: 'END', label: '終了' }, { phase: 'ENDING', step: 'CLEANUP', label: 'クリンナップ' },
];
function zoneLabel(type: string) { return ({ HAND: 'Hand', LIBRARY: 'Library', GRAVEYARD: 'Graveyard', EXILE: 'Exile', SIDEBOARD: 'Sideboard' } as Record<string, string>)[type] ?? type; }

function PlayerRail({ title, player, ownerId, game, cardMeta, own, disabled, onLife, onZone, onDropCard }: { title: string; player?: GameStateView['players'][number]; ownerId: string; game: GameStateView; cardMeta: Record<string, CardMeta>; own: boolean; disabled: boolean; onLife: (amount: number) => void; onZone: (zone: GameStateView['zones'][number]) => void; onDropCard: (event: DragEvent, zoneId: string) => void }) {
  const zones = game.zones.filter((zone) => zone.ownerPlayerId === ownerId);
  const find = (type: string) => zones.find((zone) => zone.type === type);
  const life = player?.life ?? 0;
  return <section className={`player-rail ${own ? 'own-rail' : ''}`}>
    <div className="rail-player"><span>{title}</span><strong>{life}</strong>{own && <div className="life-buttons">{[1, 5, -1, -5].map((amount) => <button key={amount} disabled={disabled} aria-label={`ライフ ${amount > 0 ? '+' : ''}${amount}`} onClick={() => onLife(amount)}>{amount > 0 ? `+${amount}` : amount}</button>)}</div>}</div>
    {(['LIBRARY', 'GRAVEYARD', 'EXILE', 'SIDEBOARD'] as const).map((type) => {
      const zone = find(type); if (!zone) return null;
      const top = zone.cards[0]; const known = top && 'cardDefinitionId' in top ? top : null;
      const meta = known ? cardMeta[`${known.cardDefinitionId}@${known.cardDefinitionVersion}`] : undefined;
      return <button className="zone-summary" key={zone.zoneId} disabled={disabled || (!own && (type === 'SIDEBOARD' || type === 'LIBRARY'))} onClick={() => onZone(zone)} onDragOver={(event) => event.preventDefault()} onDrop={(event) => onDropCard(event, zone.zoneId)} aria-label={`${zoneLabel(type)}, ${zone.cards.length}枚`}>
        <span className={`zone-stack ${type.toLowerCase()}`}>{type === 'LIBRARY' || !known ? <img src={BACK_IMAGE} alt="" /> : <img src={meta?.frontImageUrl || FALLBACK_IMAGE} alt="" onError={(event) => { event.currentTarget.src = FALLBACK_IMAGE; }} />}</span>
        <span className="zone-caption"><strong>{zoneLabel(type)}</strong><small>{zone.cards.length}枚{known && type !== 'LIBRARY' ? ` ・ ${meta?.japaneseName ?? meta?.englishName ?? ''}` : ''}</small></span>
      </button>;
    })}
    {!own && find('HAND') && <div className="zone-summary static"><span className="zone-stack"><img src={BACK_IMAGE} alt="" /></span><span className="zone-caption"><strong>Hand</strong><small>{find('HAND')?.cards.length ?? 0}枚</small></span></div>}
  </section>;
}

function PlayerHand({ label, cards, renderCard, faceDown = false, onDropCard }: { label: string; cards: GameCardView[]; renderCard: (card: GameCardView, options?: { className?: string; compact?: boolean; key?: string; viewMode?: boolean }) => React.ReactNode; faceDown?: boolean; onDropCard?: (event: DragEvent) => void }) {
  return <section className={`hand-area ${faceDown ? 'opponent-hand' : ''}`} onDragOver={onDropCard ? (event) => event.preventDefault() : undefined} onDrop={onDropCard ? (event) => onDropCard(event) : undefined}><div className="hand-label">{label}<span>{cards.length}枚</span></div><div className="hand-cards">{cards.map((card, index) => faceDown ? <img key={`back-${index}`} className="hand-back" src={BACK_IMAGE} alt="非公開カード" /> : renderCard(card, { compact: false, key: `hand-${index}` }))}</div></section>;
}
