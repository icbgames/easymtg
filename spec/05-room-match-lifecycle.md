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

再接続時の RoomStateSync には少なくとも以下を含める：

- `roomId`
- `ownerPlayerId`
- 2 人分の Player ID（参加枠の状態を含む）
- 各 Player の接続状態
- 現在の `matchId`

## 4. MatchStateSync

少なくとも以下を含める：

- `matchId`
- 現在の Game 番号（1〜5）
- Active Game の `gameId`（存在する場合）
- Match status

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

- Waiting 中の Player は自分で退出できる。
- Owner が Waiting Room を退出した場合、Room を解散するか、残った Player に Owner を移譲する規則を適用する。
- 確定仕様：Owner が退出し Room が存続する場合、残った Player が新 Owner となり `RoomOwnerChanged` を発行する。
- Game 中の切断は Room 退出ではない。
- Game 中に 30 分以内に再接続しない場合は Game を `ABANDONED` とするが、それだけで勝敗は決めない。
- Match 終了時に Room を削除するため、通常の RoomPlayerLeft を個別に発行する必要はない。

## 7. StartMatch / StartGame

Owner のみ実行可能。条件には少なくとも以下を含める：

- Room に 2 Player が参加している。
- 各 Player の Deck が有効である。
- Room / Match が適切な状態である。
- 新規 Game で使う Card Definition が存在し、ENABLED であり、必要な Version を正常に解決できる。

成功処理順：

1. Room / Player / Deck / Card Definition を検証
2. Deck Snapshot を確定
3. Card Definition ID を最新 Version に解決
4. CardInstance を生成し、各 Instance に Version を固定
5. GameState を初期化して確定
6. `GameStarted` Lifecycle Event を送信
7. `InitialState` を送信

一つでも Deck / Definition の解決に失敗した場合、Game を部分作成しない。

## 8. Game 終了

- Concede なら `FINISHED`。
- Concede 以外の継続不能状態は `ABANDONED`。
- Game 終了時に `GameEnded` Lifecycle Event を送る。
- 終了 Game は Active Game ではなくなる。
- Match が継続している間、最終 GameState は保持する。
- 次 Game の開始で前 Game の状態を引き継がない。

## 9. 切断と再接続猶予

- 全 Session が切断された直後も Game は `PLAYING` のまま。
- 相手 Player は通常操作を続行できる。
- 30 分の再接続猶予を設ける。
- 30 分経過時点で全 Session が切断中なら Game を `ABANDONED` とする。
- `ABANDONED` は勝敗確定を意味しない。
- 再接続したら同じ User / Player として復帰し、新規 Player / Game を作らない。
- 再接続で ViewState は保持されていれば同期する。
