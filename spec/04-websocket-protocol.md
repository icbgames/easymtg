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
  "lastGameId": null,
  "lastSequence": null
}
```

- `type`, `protocolVersion`, `lastGameId`, `lastSequence` を持つ。未知 field は拒否する。
- `protocolVersion` は整数`1`。`lastGameId` はGame IDまたは`null`、`lastSequence`は0以上の整数または`null`。新規接続またはローカル状態がない場合は両方 `null`。
- 再接続時は最後に適用済みの Game ID と、その Game で最後に適用済みの Event sequence を送る。片方だけ `null` の組合せは不正。
- これらは差分同期のhintであり、Game / Player選択や認可には使わない。同期対象はServerがSessionから解決するActive Room / Match / Game。
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
4. Active Game があれば、条件を満たす場合は連続した差分 `GameEvent`、それ以外は `InitialState`
5. 有効な ViewState があれば `ViewStateSync`

GameStarted 時は、`GameStarted` Lifecycle Event の後に `InitialState` を送る。

## 4. InitialState / 差分同期

- `InitialState` は Player 向けの `GameStateView` を含む。
- `gameId` と、その Game の現在 `sequence` を含む。
- InitialState に ViewState を含めない。ViewState は別の `ViewStateSync`。
- `Hello.lastGameId` が現在の Active Game と一致し、`lastSequence` が現在値より小さく、sequence の欠けない全 Event をサーバーが保持している場合は、その続きの Event を送る。
- `lastGameId` が異なる、sequence が null / 現在値以上、Event履歴に欠落がある場合は `InitialState` を送る。現在値と同じ sequence の場合も、クライアント状態を確実に再同期するため `InitialState` を送る。
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
- Clientは適用に成功したEventのsequenceだけを保持する。重複 / 回帰Eventは再適用せず、sequenceにgapがあれば後続を適用せずSocketを再接続して同期をやり直す。

### Phase 7 の実装境界

- Room create / join / WAITING leave / between-Game Deck selection / owner next-Game start requests use the HTTP endpoints defined in `spec/08-http-api.md`. After the database transaction commits, the Server refreshes open WebSocket Sessions with lifecycle notifications and current Room / Match / Game sync. A failed WebSocket notification does not roll back the HTTP operation; reconnection sync recovers the committed state.
- WebSocket adapter が Session / User / Room から対象の `gameId` と `actorPlayerId` を解決し、Game processorへ渡す。クライアントが指定したPlayer IDは認可に使用しない。
- processorから受け取るCanonical Eventは内部データとして扱い、Player別Event Viewへ変換してから配信する。この変換・配信はPhase 5 / 7の責務である。
- processorのCommandResultとEventを送信者・相手へ配る順序、Sessionごとの送信queue、切断での配信失敗処理はPhase 7で実装する。Phase 4のprocessor単体はWebSocket接続や配信を持たない。
- 1 User の複数 WebSocket Session は別々に管理する。受信 Command は Session ごとに受信順で直列化し、Game 状態変更は Game 単位の DB lock でも直列化する。
- Game単位の処理queueはDB transactionの開始からcommit後の送信queue登録までを順序化する。成功Commandの送信SessionにはCommandResultを先に登録し、そのCommandが生成したEventを続けて登録する。別CommandのEventはGame sequence順に登録する。
- RoomごとにGame / Room / Matchの状態更新と配信batch登録を直列化するcoordinatorを持つ。1 Roomには同時にActive Gameが1つだけなので、Game Command queueもこのRoom coordinator内で処理する。異なるRoomは並行処理できる。
- CommandResult は Command を送った Session のみに返す。Game Event / Lifecycle Event は仕様上の宛先 Player の全接続 Session に配信する。各 Session は単一 FIFO 送信 queue を持ち、送信者には該当 CommandResult をその Command の Game Event より先に入れる。
- Game Event は Game sequence の順に全宛先へ配信する。切断・送信失敗で配信できない Session は切断扱いとし、確定状態を巻き戻さない。再接続同期が欠落分を回復する。
- Game Event / GameState の DB commit 後、接続中 Client に配信する。commit 後、配信前にプロセス停止した場合はSocketも切断されるため、再接続時のEvent replay / `InitialState`で回復する。Lifecycle Eventは保存・再送せず、状態Syncで回復する。
- Phase 7 の初期デプロイでは WebSocket 接続を単一 Server process が所有する。複数 Server process への水平スケール、process 間の socket fanout / connection lease は対象外とし、必要になった時点で別途設計する。

## 6. Player ごとの Event View

- Canonical Game Event は両 Player 向けに配信する。
- `eventId`, `gameId`, `sequence`, `eventType` は共通。
- `payload` は Player ごとに秘匿情報をマスキングしてよい。
- 各 Player は Game sequence の欠番なし連続列を受け取る。
- Hidden Card の識別情報を漏らさずに Event を構成する。

## 7. Heartbeat

Application-level heartbeat：

- Server は 30 秒ごとに Ping を送る。
- Ping の`nonce`はServer生成UUID。Clientは受信したnonceをそのままPongで返す。未応答Pingがある場合は追加Pingを送らず、対応nonceを含まないPongは無視する。
- Ping 送信から 60 秒以内に Pong がなければ、その Session を切断扱いにする。
- WebSocket の正常 Close は即時に Session 切断扱いにする。
- Ping/Pong は Game Event ではなく sequence を消費しない。
- WebSocket確立後10秒以内にHelloを受け取れない場合はClose code `1002`で切断する。Helloを受け取る前はWelcome / Sync / Commandを送らない。

## 8. 接続状態

- Session の接続状態と Player の接続状態は別。
- Player は 1 Session 以上接続なら `CONNECTED`。
- すべての Session が切断なら `DISCONNECTED`。
- 最初の Session 接続時に `PlayerConnected`、最後の Session 切断時に `PlayerDisconnected` を発行する。
- Player レベルの Lifecycle Event に Session ID は含めない。

## 9. JSON メッセージ

Protocol Version 1 のメッセージ分類と必須 field：

| 方向 | type | payload |
| --- | --- | --- |
| Client → Server | `Hello` | `protocolVersion`, `lastGameId`, `lastSequence`。接続後の最初の1メッセージのみ。 |
| Client → Server | `Pong` | UUID `nonce`。Serverの未応答 `Ping` に対応する値。 |
| Client → Server | Game Command | `CommandEnvelope`。Command名、`commandId`、Command固有payload。Player / Room / Game IDを認可情報として含めない。 |
| Server → Client | `Welcome` | `protocolVersion`。 |
| Server → Client | `Ping` | `nonce`。30秒間隔で送信。 |
| Server → Client | `CommandResult` | `commandId`, `success`, 失敗時のみ`errorCode`。 |
| Server → Client | `GameEvent` | `eventId`, `gameId`, `sequence`, `eventType`, recipient向け`payload`。 |
| Server → Client | Lifecycle Event | 下記の共通fieldとtype固有field。 |
| Server → Client | Sync / View Notification | `RoomStateSync`, `MatchStateSync`, `InitialState`, `ViewStateSync` および `spec/06` の通知形式。 |

Lifecycle Event は `eventId`（UUID）と`type`を持つ。`RoomPlayerJoined` / `RoomPlayerLeft` は`roomId`,`playerId`、`RoomOwnerChanged`は`roomId`,`ownerPlayerId`、`PlayerConnected` / `PlayerDisconnected` は`roomId`,`playerId`,`connectionState`、`GameStarted`は`roomId`,`matchId`,`gameId`,`gameNumber`、`GameEnded`はこれらに`gameStatus`を加え、`MatchEnded`は`roomId`,`matchId`,`gameNumber`を持つ。存在しない任意fieldは送らない。勝敗情報やSession IDは含めない。宛先は`spec/05`のLifecycle Event配信規則に従う。

Sync payload は次のとおりとする：

- `RoomStateSync`: `room`。Active Room がない場合は`null`、ある場合は`roomId`,`status`,`ownerPlayerId`,`participants`（各`playerId`,`connectionState`）、`matchId`（存在する場合）を含む。Deck IDなど他Playerの非公開情報を含めない。
- `MatchStateSync`: `match`。Active Match がない場合は`null`、ある場合は`matchId`,`status`,`currentGameNumber`,`activeGameId`（存在する場合）を含む。
- `InitialState`: `gameId`, 現在の`sequence`, 受信者向け`GameStateView`。
- `ViewStateSync`と各View Notificationは`spec/06-view-state.md`の形式に従う。

JSON は UTF-8 Text Message のみとする。不正JSON、最初のHelloの欠落・形式不正、非対応protocolVersion、既知でないClient control messageはClose code `1002`で終了する。`commandId`を含むメッセージはCommand Envelopeとして扱い、未知Command typeも`UNKNOWN_COMMAND`を返す。Frameがtransportの最大受信サイズを超えた場合はClose code `1009`。認証されていない接続はUpgrade前にHTTP 401で拒否する。認識可能なCommand type / commandIdに対するpayload不正は`CommandResult` errorにする。`commandId`を有効に解釈できない不正Command Envelopeは`spec/11`のprotocol errorとして扱う。

Protocol の Zod union schema は実装時に `packages/shared` へ集約し、本節および`spec/03` / `spec/05` / `spec/06`を定義元とする。実装型を仕様書へ重複転記しない。
