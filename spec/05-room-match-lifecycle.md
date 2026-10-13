# 05. Room / Match / Game Lifecycle

## 1. Lifecycle Event と Game Event の区別

Room / Match / Game のライフサイクル通知は Game Event と別系統にする。

例：
- `RoomPlayerJoined`
- `RoomPlayerLeft`
- `RoomOwnerChanged`
- `PlayerConnected`
- `PlayerDisconnected`
- `GameStarted`
- `GameEnded`
- `MatchEnded`

Lifecycle Event は `eventId` を持つが Game `sequence` は持たない。Event 履歴は再接続同期に使わず、再接続時は現在状態の Sync メッセージを送る。

## 2. Lifecycle Event の配信

- 現在 Room に参加している Player 全員に送る。
- `RoomPlayerJoined` は参加者本人を含む現在の Room Player に送る。
- `RoomPlayerLeft` は退出者を除く残りの Player に送る。
- 一時的な WebSocket 切断は Room 退出ではない。
- 同一 Session 内で Lifecycle Event の順序を保証する。
- Lifecycle Event の履歴は保持しない。
- Event ID は全体一意。

## 3. RoomStateSync

再接続時は`RoomStateSync`を必ず送る。Active Room がない場合は`room: null`、存在する場合は`roomId`, `status`, `ownerPlayerId`, 実際の参加者配列（各`playerId`,`connectionState`）、`matchId`（Match作成後）を含む。空き枠は参加者配列に仮Player IDを入れず、最大2名というRoom規則から表現する。他PlayerのDeck IDは送らない。

## 4. MatchStateSync

`MatchStateSync`は必ず送る。Active Matchがない場合は`match: null`、存在する場合は`matchId`, `status`, `currentGameNumber`, Active Gameの`activeGameId`（存在する場合）を含める。

勝敗集計・勝敗情報は含めない。

## 5. Player 接続状態イベント

`PlayerConnected` / `PlayerDisconnected` payload：

- `eventId`
- `type`
- `roomId`
- `playerId`
- `connectionState`

Session ID は含めない。

## 6. Room 参加・退出・Owner 移譲

- Room 作成時は Owner 1 名で `WAITING` を開始する。
- `WAITING` 中は Player が退出できる。退出後に参加 Player がいなければ Room を削除する。退出後も Player が残る場合は Room を維持し、残った Player を新 Owner として `RoomOwnerChanged` を発行する。
- 2 人目の入室は Match / Game 1 開始と同一の原子的処理であり、成功時は Room を直ちに `IN_MATCH` にする。従って、現在の2人対戦フローでは2名が参加した `WAITING` Room は確定状態として存在せず、Owner退出後に他 Player が残るケースは通常発生しない。上記の移譲規則は、退出処理が残存 Player を持つ状態を扱う場合にもOwner不在を生じさせないための定義である。
- `IN_MATCH` 中の明示的な Room 退出は認めない。Game 中の切断は Room 退出ではなく、切断・再接続猶予の規則に従う。
- Match 終了時は Room を削除する。
- Game 中に 30 分以内に再接続しない場合は Game を `ABANDONED` とするが、それだけで勝敗は決めない。

Room の確定状態遷移：

| 現在状態 | 操作 | 成功後 |
| --- | --- | --- |
| Room なし | 有効な Deck を指定して作成 | Owner 1 名の `WAITING` |
| Owner 1 名の `WAITING` | 2 人目が有効な Deck で入室し Match / Game 1 開始に成功 | 2 名の `IN_MATCH` |
| Owner 1 名の `WAITING` | Owner が退出 | Room 削除 |
| 残存 Player がいる `WAITING` | Owner が退出 | 残存 Player へOwnerを移譲して `WAITING` 維持（現行フローでは通常到達しない状態への防御規則） |
| `IN_MATCH` | Player の一時切断 | Room / Match を維持し接続状態だけ更新 |
| `IN_MATCH` | Match 終了 | Room 削除 |

2人目の入室処理が失敗した場合は、RoomをOwner 1名の`WAITING`のまま維持し、2人目を参加確定せず、Match / Game も作成しない。

## 7. Match / Game の開始

WAITING Room に2人目の Player が入室した時点で、Match と Game 1 を自動開始する。入室操作の一部として原子的に扱い、開始処理が失敗した場合は2人目を参加者として確定せず、Match / Game も作成しない。

Game 2〜5 は前 Game の終了後に Room owner の操作で開始する。開始条件には少なくとも以下を含める：

- Room に 2 Player が参加している。
- 各 Player の Deck が有効である。
- Match が `ACTIVE` で、進行中 Game がなく、次の Game 番号が 2〜5 である。
- 操作者が Room owner である。
- 新規 Game で使う Card Definition が存在し、ENABLED であり、必要な Version を正常に解決できる。

成功処理順：

1. Room / Player / Deck / Card Definition を検証
2. Deck Snapshot を確定
3. Card Definition ID を最新 Version に解決
4. CardInstance を生成し、各 Instance に Version を固定
5. GameState を初期化して確定
6. `GameStarted` Lifecycle Event を送信
7. `InitialState` を送信

Game 1 の開始主体は2人目の入室処理であり、Game 2〜5 は Room owner の開始操作である。Match status は `ACTIVE` / `ENDED` とし、Game 間の待機中は `activeGameId` を持たない。各 Game の Snapshot はその Game 開始時の Deck 内容とし、Sideboard 変更を反映する。

一つでも Deck / Definition の解決に失敗した場合、Game を部分作成しない。

## 8. Game 終了

- Concede なら `FINISHED`。
- Concede 以外の継続不能状態は `ABANDONED`。
- Game 終了時に `GameEnded` Lifecycle Event を送る。
- 終了 Game は Active Game ではなくなる。
- Game 1〜4 の終了後も Match は `ACTIVE` のままとし、残りの Game を省略しない。
- Game 5 終了時に Match を `ENDED` とし、Room を削除する。
- Match が継続している間、最終 GameState は保持する。
- 次 Game の開始で前 Game の状態を引き継がない。

## 9. 切断と再接続猶予

- 全 Session が切断された直後も Game は `PLAYING` のまま。
- どちらか一方の Player が切断中は、接続中 Player の Game 操作を禁止する。両 Player の接続が確認できた時点で操作を再開できる。
- Gameが進行中に両Playerの全Sessionが切断状態になった時点で30分の再接続猶予を開始する。どちらかのPlayerにSessionが接続した時点で猶予を解除し、後に再び両Playerが全Session切断になった場合はその時点から新たに30分を計る。
- 猶予開始から30分経過した時点で両Playerの全Sessionが引き続き切断中かつGameが`PLAYING`なら、Gameを`ABANDONED`とする。再接続とtimeoutが競合した場合はGame row lock下で状態を再確認し、先に確定した再接続状態を尊重する。
- `ABANDONED` は勝敗確定を意味しない。
- 再接続したら同じ User / Player として復帰し、新規 Player / Game を作らない。
- 再接続で ViewState は保持されていれば同期する。
