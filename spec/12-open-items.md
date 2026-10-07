# 12. 未決定事項・実装時に確定する事項

この一覧は、合意済み仕様を再検討するリストではなく、現時点で具体値や実装方式が未確定の事項を集約する。

## 1. Protocol / API

- Protocol 全メッセージの完全な JSON schema / Zod schema。
- 全 Game Event / Lifecycle Event / View Notification の eventType と payload 定義。
- 全 Command の payload schema と完全な errorCode 一覧。
- Deck CRUD の HTTP endpoint、payload、成功・エラー response。
- Card Definition search の全 query parameter 名・encoding の最終固定。
- `GET /api/card-definitions/{cardDefinitionId}` を一般 API に実装するか。
- 管理 API の Version + Status 同時更新 endpoint の具体的 URL / method。
- 各 API の HTTP status code の完全な対応表。

## 2. Authentication / Session

- 匿名 User ID の具体的な形式・Cookie 名・期限・更新・失効方式。
- Cookie の `Secure`, `HttpOnly`, `SameSite` 等の具体設定。
- 管理者認証方式（管理者専用ログイン / 外部認証等）。
- 管理者の権限モデル（現状は管理者権限を持つ利用者に限定する方針のみ確定）。

## 3. Storage / Database

- PostgreSQL schema、table、index、migration。
- GameState / Event / ViewState / Session / Room / Match / Deck / Card Definition の具体的永続化方式。
- Game Event と GameState の commit transaction 境界の DB 実装詳細。
- Match end 後の Room / GameState cleanup のタイミング。
- 管理 API idempotency record の保持期間と削除方式。
- Game / Room / User データのバックアップ・障害復旧方針。

## 4. Limits / Runtime

- HTTP body の最大サイズ。
- `rulesData` の最大ネスト深度と必要に応じたサイズ上限。
- WebSocket message 最大サイズ。
- 接続数、Rate limit、一般的な abuse protection。カード検索専用 Rate Limit は現時点では設けない方針。
- Server / DB の deployment、hosting、production configuration。

## 5. Card rules / UI

- `rulesData` の個別 schema と、未定義 key の許容可否。
- Battlefield の grid 原点、負座標の許可、重なり表示、auto-place の詳細。
- Context menu による自動配置の具体的な配置アルゴリズム。
- `ChangeLife.amount = 0` の扱い。
- Game UI の詳細、レスポンシブ対応、アクセシビリティ、具体的な表示規則。
- Card image placeholder と common back image の具体アセット。
- Card Definition search に将来追加する type / cost 等の属性と filter 仕様。

## 6. Tests / Operations

- Vitest の unit / integration / end-to-end テストの具体的な構成。
- Property-based / fuzz test を導入するか。
- CI workflow、lint / formatter、typecheck の具体設定。
- Logging / metrics / tracing / alerting の設計。
- 運用環境での管理 API の秘密情報管理。

## 7. 決定済みなので勝手に変更しない項目

- 中央サーバー方式、常に 2 人対戦。
- Game は必ず Match に所属し、Game 1〜5 を実施。
- システムによる勝敗判定なし。
- User と Player は別概念。匿名 User ID を利用。
- Zone は 6 種類、Game あたり 11 Zone。
- Mainboard 保存・使用条件は 60 枚以上。
- Card Definition ID は 3 英字 + 3 数字、正規化後永久に再利用不可。
- Card Definition Version は不変。Game 開始時に各 CardInstance へ固定。
- Game Event sequence は Game ごと、eventId は全体一意。
- Command は Game ごとに直列処理。失敗 Command は後続を止めない。
- ViewState は Canonical GameState 外で、Game sequence を消費しない。
- DISABLED カードを Deck から自動削除しない。
- 画像は外部 URL 参照、HTTPS のみ、サーバー proxy なし。
