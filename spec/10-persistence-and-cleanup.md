# 10. 永続化・履歴・クリーンアップ

## 1. 永続化の基本

- GameState はサーバーで保持し、永続化・復元可能とする。
- Game の状態変更は Game ごとに直列化する。
- Event の状態変更・sequence・永続化を確定してから配信する。
- DB の具体的な schema / index / transaction 境界は実装設計時に決定する。
- 採用技術は PostgreSQL + Drizzle ORM。

## 2. Game Event history

- Game が PLAYING の間、再接続差分同期用に Game Event history を保持する。
- Game 終了後は Event history を削除してよい。
- Game 終了後の再接続では Event history replay ではなく現在状態を同期する。
- Lifecycle Event history は保持しない。
- View Notification は Game Event history に含めない。

## 3. GameState の保持

- Game 終了後も、その Game の最終 GameState は Match 終了まで保持する。
- 次の Game は新規 GameState を作成し、前 Game の状態を引き継がない。
- Match 終了後は Room / GameState を削除可能。
- 具体的な DB 削除タイミング、論理削除の採否は未決定。

## 4. Card Definition Version cleanup

- 最新 Version は常に保持する。
- 古い Version は Active Game から参照されている間保持する。
- Active Game から参照されなくなった Version は非同期 cleanup で削除可能。
- cleanup は削除直前に参照を再確認する。
- 固定 retention period は設けない。
- 手動 Version 削除 API は設けない。
- Card Definition 自体は物理削除しない。
- Game 終了後、Match が続いていても古い Version が Active Game から参照されなければ削除可能。
- 将来 Replay / 永続的な履歴機能を追加する場合は、必要な Card Definition Version 情報を別途保存する。

## 5. 管理 API idempotency record

- 管理 API の requestId と結果を記録する。
- 成功・失敗ともに再送で同じ結果を返す。
- requestId 記録と master 更新は可能な限り同一 transaction。
- 保持期間と削除処理は未決定。再送の安全性を損なわない期間を保証する。
