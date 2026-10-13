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
- 固定errorCodeとHTTP statusの対応は `11-security-and-errors.md` を参照する。
- API URL・schema は実装時に `packages/shared` の Zod schema 等へ集約する。

## 2. Card Definition Search

### Endpoint

`GET /api/card-definitions`

一覧と検索を同じ endpoint で扱う。Deck編集時に既存Deck内のDISABLEDカードを表示するため、詳細API `GET /api/card-definitions/{cardDefinitionId}` も提供する。

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

Query parameter は上記の `q`, `page`, `sort`, `order`, `status` に固定し、RFC 3986に従う通常のURL query encodingを使う。`sort`と`order`はcomma-separated。`status`は省略時・`ENABLED`指定時ともにENABLEDのみを返し、それ以外の値は`INVALID_REQUEST`とする。未定義parameterは`INVALID_REQUEST`。

### 検索ロジック

- 対象は `cardDefinitionId`, `englishName`, `japaneseName`。
- 部分一致・大文字小文字区別なし。
- NFKC 正規化を検索時に適用。
- 半角・全角空白で検索語を分割し、すべての語がいずれかの対象フィールドに部分一致すること（AND）。
- 前後空白を trim。連続空白は複数の separator として扱う。
- 最大長は NFKC 後 100 文字。超過時はエラー。
- 空検索は ENABLED カード全件（filter 適用後）。
- 既定順は `englishName ASC, cardDefinitionId ASC`。
- sort whitelist は `englishName`, `japaneseName`, `cardDefinitionId`。複数 sort をサポートし、指定がなければ既定順を使う。
- `japaneseName` がない Card Definition は空文字として比較する。指定 sort で同順位の場合は `cardDefinitionId ASC` を最終 tie-breaker とする（IDがsort条件に含まれる場合は重ねて適用しない）。
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

### Deck CRUD

一般APIは匿名User Sessionを要求し、各操作はSession所有者のDeckだけに適用する。

| Method / endpoint | Body | Response |
| --- | --- | --- |
| `GET /api/decks` | なし | `DeckSummary[]`。`updatedAt DESC, id ASC`。全件を返す。 |
| `POST /api/decks` | `{ name, mainboard, sideboard? }` | 作成したDeck。 |
| `GET /api/decks/{deckId}` | なし | Deck詳細。 |
| `PUT /api/decks/{deckId}` | `{ name, mainboard, sideboard? }` | 全フィールドを置換したDeck詳細。 |
| `DELETE /api/decks/{deckId}` | なし | `{ deleted: true }`。 |

Deck responseは`id`, `name`, `mainboard`, `sideboard`, `updatedAt`を含み、User IDは含めない。一覧は`id`, `name`, `mainboardCount`, `sideboardCount`, `updatedAt`のみを返す。nameはtrim後1〜100文字、同名Deckを許可する。mainboardは保存時60枚以上、sideboardは0〜15枚。`sideboard`省略時は空配列。Deckは明示保存のみで、60枚未満の作業中内容はクライアントにのみ保持する。

PUTは全件置換とし、競合時は後から保存した内容を採用する。DISABLEDカードを含む既存Deckも保存・編集できる。Room/Gameでの利用可否はRoom/Game開始時に検証し、自動削除しない。DELETEは完全削除するが、Roomが参照中のDeckは`409 DECK_IN_USE`で拒否する。他User所有または存在しないDeckは`404 DECK_NOT_FOUND`として同一応答にする。

成功応答はHTTP 200 JSON。入力構造不正は`400 INVALID_REQUEST`、保存条件違反（枚数/name等）は`400 DECK_INVALID`、delete中の使用Deckは`409 DECK_IN_USE`。エラーbodyはSection 1の共通形式。

### 次Game用の一時Sideboard構成

Game 1〜4の終了後、各Playerは直前GameのDeckSnapshotを基準にMainboard / Sideboard間でカードを移動する。合計カード構成（カードIDごとの枚数）は変えられない。構成はRoomPlayer単位で一時保存し、保存Deckを更新しない。次Gameの開始に成功したら一時構成と確定状態を消去し、新しいGameのSnapshotを次の基準にする。

| Method / endpoint | Body | Response |
| --- | --- | --- |
| `GET /api/rooms/current` | なし | Room概要、本人の`selectedDeckId`、Game間なら本人の次Game用構成と双方の確定状態。相手のカード構成は含めない。 |
| `PUT /api/rooms/current/next-game-deck` | `{ mainboard, sideboard }` | 構成を保存し、要求者を確定済みにする。 |
| `POST /api/rooms/current/games/next` | なし | Room ownerが次Gameを開始する。双方の確定が必要。 |

確定後に編集すると確定状態を解除し、再確定が必要。どちらか一方が未確定ならGame開始は`409 PLAYERS_NOT_READY`。カード集合・枚数条件違反は`400 DECK_INVALID`、利用不可カードは`400 CARD_UNAVAILABLE`。一時構成はGame初期化のDatabase transaction内でSnapshotへ反映し、次Game開始とconfirmation resetを原子的に確定する。

### 固定Card Definition Version API

`GET /api/card-definitions/{cardDefinitionId}/versions/{version}`はSession認証を要求し、指定した不変Versionを返す。GameStateViewで当該カード識別情報を受信したClientは、このAPIを使ってGame開始時に固定された名称・画像を表示する。未存在は`404 CARD_DEFINITION_NOT_FOUND`。

`GET /api/card-definitions/{cardDefinitionId}`はSession認証を要求し、指定IDの最新Version全フィールドと現在の`status`を返す。DISABLEDを含む既存Deckの編集・表示に使う。未存在は`404 CARD_DEFINITION_NOT_FOUND`。

## 4. Room / Match lifecycle API

Room lifecycle の操作要求は HTTP API で受け付け、ゲーム内操作とリアルタイム同期は `spec/04-websocket-protocol.md` の WebSocket に分ける。匿名User Sessionを必須とし、UserからRoom participant / Playerをサーバー側で解決する。クライアントが送るPlayer IDを認可根拠として使わない。

| Method / endpoint | Body | 成功時の処理 |
| --- | --- | --- |
| `GET /api/rooms/current` | なし | Userが参加中のRoomを返す。参加中でなければ`room: null`。 |
| `GET /api/rooms/current/game-state` | なし | 現在Gameの本人向けGameStateViewを返す。対戦中Gameがなければ`game: null`。 |
| `POST /api/rooms` | `{ deckId }` | 新しいPlayer IDとWAITING Roomを作成する。 |
| `POST /api/rooms/{roomId}/join` | `{ deckId }` | Roomへ参加する。2人目ならMatch / Game 1開始まで同一transactionで行う。 |
| `DELETE /api/rooms/current` | なし | WAITING Roomから退出する。IN_MATCH中は拒否する。 |
| `PUT /api/rooms/current/next-game-deck` | `{ mainboard, sideboard }` | Game間に本人の一時構成を保存して確定する。 |
| `DELETE /api/rooms/current/next-game-deck/confirmation` | なし | 本人の次Game構成の確定を取り消す。 |
| `POST /api/rooms/current/games/next` | なし | Room ownerとしてGame 2〜5の次Gameを開始する。 |

成功応答はJSONとHTTP 200。`GET /api/rooms/current/game-state`は`{ game: { gameId, sequence, gameStateView } | null }`を返し、Viewには認証済みPlayer向けに公開可能な情報だけを含む。応答の`room`は`roomId`, `status`, `ownerPlayerId`, `participants`（`playerId`, `connectionState`のみ）, 任意の`matchId`を含む。Deck IDはRoom参加者全員には公開せず、WebSocket syncの公開Room情報から除外する。操作応答には要求した本人の`playerId`と本人に限った`selectedDeckId`を含め、Game開始時は`gameId`と`gameNumber`を含める。`GET`は参加中なら`{ room, playerId, selectedDeckId, nextGameDeck? }`、Roomがなければ`{ room: null }`を返す。Game間の`nextGameDeck`は本人の構成と`confirmed`、相手の`opponentConfirmed`のみ含む。相手のDeck ID・構成は返さない。

Room / Match / Gameの永続状態をtransactionで確定した後、接続中WebSocket SessionへLifecycle EventとRoom / Match / Game syncをFIFOで配信する。通知失敗でHTTP操作やDB commitを巻き戻さない。クライアントは現在RoomをGETでき、WebSocket再接続時にも正本状態を同期できる。

Request bodyはstrict schemaで検証し、余分なfield・不正IDを`INVALID_REQUEST`（400）とする。Session未認証は`UNAUTHENTICATED`（401）、owner権限不足は`FORBIDDEN`（403）、対象Room / membership / Deck不在は個別の404、DeckやCardの使用条件違反は400、Room / Match状態競合は409とする。error bodyはSection 1および`spec/11-security-and-errors.md`の共通形式に従う。
