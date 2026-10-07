# 08. 一般ユーザー向け HTTP API

## 1. 共通原則

- API は JSON を基本とする。
- HTTP API のエラー形式：

```json
{
  "error": {
    "code": "INVALID_PAGE",
    "message": "Invalid page number."
  }
}
```

- `code` は固定の機械判定用値、`message` は人間向け説明。
- HTTP status code はエラーの大分類を表す。
- WebSocket CommandResult とは別形式。
- API URL・schema は実装時に `packages/shared` の Zod schema 等へ集約する。

## 2. Card Definition Search

### Endpoint

`GET /api/card-definitions`

一覧と検索を同じ endpoint で扱う。詳細 API `GET /api/card-definitions/{cardDefinitionId}` は必要に応じて提供できるが、現時点では検索結果に最新 Version の全フィールドを含めるため、検索後に詳細取得を必須としない。

### 認証

- 匿名 User ID Session を要求する。
- 管理 API の認証とは独立。

### Query

- `q`: 任意。検索文字列。
- `page`: 1 から始まるページ番号。
- `sort`: comma-separated sort field。
- `order`: sort field と同じ数の `asc` / `desc`。
- `status`: 一般ユーザー向け検索では新規追加候補として ENABLED のみを返す。DISABLED を一般検索に含めるかどうかは管理 API の責務とする。
- `limit` は受け付けない。page size は固定 50。

具体的な query parameter 名・URL encoding は API schema 実装時に固定する。

### 検索ロジック

- 対象は `cardDefinitionId`, `englishName`, `japaneseName`。
- 部分一致・大文字小文字区別なし。
- NFKC 正規化を検索時に適用。
- 半角・全角空白で検索語を分割し、すべての語がいずれかの対象フィールドに部分一致すること（AND）。
- 前後空白を trim。連続空白は複数の separator として扱う。
- 最大長は NFKC 後 100 文字。超過時はエラー。
- 空検索は ENABLED カード全件（filter 適用後）。
- 既定順は `englishName ASC, cardDefinitionId ASC`。
- sort/order は whitelist。複数 sort をサポート。
- server-side filtering の後に pagination。
- 条件変更時、クライアントは page=1 に戻す。
- debounce 300ms を基本とし、古いレスポンスを破棄する。
- 長期 browser cache はしない。

### Response

```ts
type CardDefinitionSearchResponse = {
  items: CardDefinitionVersionWithStatus[];
  page: number;
  pageSize: 50;
  totalCount: number;
  totalPages: number;
};
```

各 item は少なくとも以下を含む：

- `cardDefinitionId`
- `version`
- `englishName`
- `japaneseName`
- `hasBack`
- `backName`
- `frontImageUrl`
- `backImageUrl`
- `createdAt`
- `changeDescription`
- `rulesData`
- `status`（現在の Card Definition Status）

通常の新規追加候補では ENABLED のみ返す。既存 Deck 内の DISABLED カードは別途表示・編集可能にする。管理検索は `09-admin-api.md` を参照。

### Pagination

- `page` は 1 以上の整数。
- `page=0`、負数、非数は request error。
- 範囲外の page は空 items を返し、要求 page と実際の totalCount / totalPages を返す。
- 0 件の場合 `totalCount=0`, `totalPages=0`。
- pageSize は常に 50。

## 3. Deck API

Deck の CRUD endpoint、具体的な HTTP method / URL / payload は **未決定**。実装前に Deck の保存・取得・編集・削除 API を定義し、以下の確定ルールを反映する：

- 明示的な Save のみ。自動保存しない。
- Mainboard 60 枚以上で保存可能。
- 編集途中の 60 枚未満は許容する。
- Room 作成・参加・Game 開始時には Deck を検証する。
- Sideboard の枚数制限なし。
- Deck composition は `cardDefinitionId` のみ保存し、Version は保存しない。
- DISABLED カードを自動削除しない。
