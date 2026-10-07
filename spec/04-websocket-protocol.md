# 04. WebSocket Protocol

## 1. 接続

- WebSocket endpoint は `/ws` の 1 つ。
- URL に `roomId` / `matchId` / `gameId` を含めない。
- サーバーは Cookie / Session から User を識別し、Active Room を特定する。
- Active Room がない User でも WebSocket 接続できる。
- Protocol Version 1 は JSON Text Message のみ。Binary WebSocket Message は使用しない。
- カード画像などの画像データを WebSocket で送らない。

## 2. Hello / Welcome

クライアント最初のメッセージ：

```json
{
  "type": "Hello",
  "protocolVersion": 1,
  "lastSequence": null
}
```

- `type`, `protocolVersion`, `lastSequence` を持つ。
- `lastSequence` は必須だが nullable。
- 新規接続は `null`、再接続は最後に適用済みの Game Event sequence。
- `lastSequence` は現在の Game の sequence として解釈する。
- Hello に `roomId` を含めない。

Welcome：

```json
{
  "type": "Welcome",
  "protocolVersion": 1
}
```

- Welcome には User / Player / Room / Match / Game ID を含めない。
- 現在状態は後続の同期メッセージで取得する。

## 3. 接続直後・再接続時のメッセージ順序

順序を保証する：

1. `Welcome`
2. `RoomStateSync`
3. `MatchStateSync`
4. Game が進行中なら `InitialState`
5. 有効な ViewState があれば `ViewStateSync`

GameStarted 時は、`GameStarted` Lifecycle Event の後に `InitialState` を送る。

## 4. InitialState / 差分同期

- `InitialState` は Player 向けの `GameStateView` を含む。
- `gameId` と、その Game の現在 `sequence` を含む。
- InitialState に ViewState を含めない。ViewState は別の `ViewStateSync`。
- Hello の `lastSequence` と現在の Game が同一で、サーバーが後続の全 Event を保持している場合は、差分 Event のみ送信できる。
- Event 履歴が不足している、または現在の Game が異なる場合は `InitialState` を送る。
- 再接続同期は現在の Active Game のみ対象とする。
- 前 Game の最終 GameState はサーバーに保持されていても、再接続時に復元しない。
- Game1 終了後・Game2 開始前なら Room / Match の状態のみ同期する。

## 5. Sequence

- `sequence` は Game ごとに 1 から始まる。
- Event ごとに 1 増加する。
- `eventId` は全 Game で一意で、sequence とは独立。
- `gameId` と `sequence` をセットで扱う。
- 失敗 Command は Event を発行せず、sequence を消費しない。
- Client は同じ Session で sequence が回帰する Event を受け取らない。
- `clientSequence` は設けない。WebSocket の Session 内の受信順と `commandId` で管理する。

## 6. Player ごとの Event View

- Canonical Game Event は両 Player 向けに配信する。
- `eventId`, `gameId`, `sequence`, `eventType` は共通。
- `payload` は Player ごとに秘匿情報をマスキングしてよい。
- 各 Player は Game sequence の欠番なし連続列を受け取る。
- Hidden Card の識別情報を漏らさずに Event を構成する。

## 7. Heartbeat

Application-level heartbeat：

- Server は 30 秒ごとに Ping を送る。
- Client は Pong で応答する。
- Ping 送信から 60 秒以内に Pong がなければ、その Session を切断扱いにする。
- WebSocket の正常 Close は即時に Session 切断扱いにする。
- Ping/Pong は Game Event ではなく sequence を消費しない。

## 8. 接続状態

- Session の接続状態と Player の接続状態は別。
- Player は 1 Session 以上接続なら `CONNECTED`。
- すべての Session が切断なら `DISCONNECTED`。
- 最初の Session 接続時に `PlayerConnected`、最後の Session 切断時に `PlayerDisconnected` を発行する。
- Player レベルの Lifecycle Event に Session ID は含めない。

## 9. JSON メッセージ

Protocol の具体的な全 union 型・Zod schema は実装時に `packages/shared` に集約する。仕様書と実装のフィールド名を二重管理しない。
