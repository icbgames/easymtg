# 11. セキュリティ・入力検証・エラー

## 1. User / Session

- 一般利用者は匿名 User ID で識別する。
- User ID はサーバー発行し、Cookie 等で保持する。
- Client が送る `playerId` / `roomId` / `gameId` を認可根拠として信用しない。
- Session と User / Player / Active Room の対応をサーバー側で解決する。
- 一般ユーザー向け Card Definition search は匿名 Session を要求する。

## 2. 管理者

- 管理 API は匿名 User Session と独立した認証・認可を必須とする。
- 管理者の具体的な認証方式は未決定。
- 一般ユーザーの匿名 User ID だけで Card Definition を変更できない。
- 専用監査ログは現時点で設けない。
- Status の変更履歴は保存しない。

## 3. Command authorization

- Command 実行者は接続 Session から特定する。
- カード操作は原則として現在 Controller が実行する。
- ChangeLife は自分の Life のみ変更可能。
- ShuffleZone は Zone owner が実行する。
- ChangeTurnPosition / EndTurn は Active Player が実行する。
- Room owner は StartMatch / StartGame を行えるが、Game 中の勝敗や相手の操作を強制できない。
- ViewState の非公開 cardId は有効な ViewState に含まれることをサーバーが検証する。

## 4. HTTP error format

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Invalid request."
  }
}
```

- `code` は固定値。
- `message` は説明。
- HTTP status code は大分類。
- 管理 API と一般 HTTP API で形式を共通化する。
- WebSocket CommandResult は別形式。

## 5. 入力検証

- HTTP request / WebSocket message は schema validation を行う。
- 採用技術として Zod を利用する。
- 不正入力で部分更新しない。
- GameState 変更は validate → mutate → Event / sequence 確定 → persistence の順に行う。
- Command failure は GameState と sequence を変更しない。
- HTTP body の最大サイズ制限を設ける。具体値は未決定。
- Card search query は NFKC 後 100 文字まで。
- `rulesData` の最大ネスト深度・最大サイズの具体値は未決定。トップレベル object、重複 key 不可、JSON 標準値のみ等の規則は `07-decks-and-card-definitions.md` を参照。

## 6. 外部画像 URL

- HTTPS absolute URL のみ許可。
- 登録時に URL の実取得確認はしない。
- Server proxy はしない。Client が直接ロードする。
- 画像エラー時の placeholder / common back image はクライアント側で表示する。
- URL の定期監視はしない。

## 7. HTTP status code

一般的な方針：
- `400`: 不正な request / query
- `401`: 未認証
- `403`: 認可失敗
- `404`: リソース不存在
- `409`: 状態競合 / requestId conflict / Version conflict
- `413`: Payload Too Large
- `500`: 想定外のサーバーエラー

具体的な各エラーと HTTP status の割当は実装時に確定する。
