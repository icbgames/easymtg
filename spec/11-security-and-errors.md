# 11. セキュリティ・入力検証・エラー

## 1. User / Session

- 一般利用者は匿名 User ID で識別する。
- User ID はサーバー発行し、Cookie 等で保持する。
- Client が送る `playerId` / `roomId` / `gameId` を認可根拠として信用しない。
- Session と User / Player / Active Room の対応をサーバー側で解決する。
- 一般ユーザー向け Card Definition search は匿名 Session を要求する。

### Phase 7 MVP Session / Cookie

- Session IDはCSPRNGで生成する256-bitのopaque token（base64url文字列）とし、DBにはtokenそのものではなくSHA-256 hashを保存する。User IDはUUIDとする。
- Cookie名は`easymtg_session`、`Path=/`、`HttpOnly`、`SameSite=Lax`、有効期間30日のsliding expirationとする。TLS終端後のproductionでは`Secure`を必須とし、localhostのHTTP開発環境ではSecureを付けない。
- Sessionが有効な間、各HTTP要求およびWebSocket handshakeで期限を検証する。Sessionの有効期限は最終利用から30日とし、利用時に延長する。ログアウトAPIは現時点で設けず、期限切れSessionはcleanup対象とする。
- Cookieがない、期限切れ、または対応Sessionがない場合、一般APIは`UNAUTHENTICATED`（401）、WebSocket upgradeはHTTP 401とする。匿名Session発行専用HTTP APIは現時点で追加せず、一般Web画面の初回アクセス時にServerが発行する。
- 管理者認証はこのMVP Sessionを流用しない。単独管理者向けに`ADMIN_API_TOKEN`のBearer認証を使用し、token未設定時は管理APIを登録しない。

## 2. 管理者

- 管理 API は匿名 User Session と独立した認証・認可を必須とする。認証方式と運用は`09-admin-api.md`を参照する。
- 一般ユーザーの匿名 User ID だけで Card Definition を変更できない。
- 専用監査ログは現時点で設けない。
- Status の変更履歴は保存しない。

## 3. 入力サイズ上限（Phase 7 MVP）

- HTTP JSON bodyは最大1 MiB。超過は`PAYLOAD_TOO_LARGE`（413）。
- WebSocket JSON Text frameは最大1 MiB。超過はClose code `1009`。
- Card Definition `rulesData`はUTF-8 JSON表現で最大64 KiB、object nesting depth最大16。超過はCard Definitionの入力エラーとして拒否する。
- 上記制限は受信本文・JSON構造に適用し、ゲーム内カード枚数やZone配列の件数上限を追加しない。

## 4. Command authorization

- Command 実行者は接続 Session から特定する。
- Battlefield 上のカード操作は原則として現在 Controller が実行する。非戦場Zoneからの移動・並べ替えは Owner が実行する。
- ChangeLife は自分の Life のみ変更可能。
- ShuffleZone は Zone owner が実行する。
- ChangeTurnPosition / EndTurn は Active Player が実行する。
- Room owner は StartMatch / StartGame を行えるが、Game 中の勝敗や相手の操作を強制できない。
- ViewState の非公開 cardId は有効な ViewState に含まれることをサーバーが検証する。

## 5. HTTP error format

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

## 6. 入力検証

- HTTP request / WebSocket message は schema validation を行う。
- 採用技術として Zod を利用する。
- 不正入力で部分更新しない。
- GameState 変更は validate → mutate → Event / sequence 確定 → persistence の順に行う。
- Command failure は GameState と sequence を変更しない。
- HTTP JSON body は最大 1 MiB とし、超過時は `PAYLOAD_TOO_LARGE`（413）を返す（Section 3）。
- Card search query は NFKC 後 100 文字まで。
- `rulesData` はUTF-8 JSON表現で最大64 KiB、object nesting depth最大16とする（Section 3）。その他の構造規則は `07-decks-and-card-definitions.md` を参照。

## 7. 外部画像 URL

- HTTPS absolute URL のみ許可。
- 登録時に URL の実取得確認はしない。
- Server proxy はしない。Client が直接ロードする。
- 画像エラー時の placeholder / common back image はクライアント側で表示する。
- URL の定期監視はしない。

## 8. HTTP status code

### Command errorCode

WebSocket `CommandResult.errorCode` は次の固定値だけを許可する。Game操作で発生するものはGameStateを変更せず、sequenceも消費しない。

| errorCode | 意味 |
| --- | --- |
| `INVALID_ENVELOPE` | Envelope不正。`commandId`が有効ならCommandResultを返す。 |
| `COMMAND_ID_CONFLICT` | 同じ`commandId`が、元のGame・実行者・Command type・payloadと異なる内容で再利用された。 |
| `VIEW_NOT_FOUND` | 実行者に属する有効なViewStateがない、またはviewIdが一致しない。 |
| `VIEW_CARD_NOT_FOUND` | 指定カードがGameまたはViewerのViewStateに存在しない。 |
| `VIEW_ACCESS_DENIED` | ViewStateの対象Zone・閲覧枚数に対する権限がない。 |
| `INVALID_VIEW_ORDER` | 並べ替え指定が閲覧対象カードの完全な順列ではない。 |
| `INVALID_VIEW_SELECTION` | Confirmの移動指定が選択済みの一意なカード集合に含まれない。 |
| `VIEW_STALE` | 閲覧開始後に閲覧対象カードがsource Zoneを離れ、ViewStateを確定できない。 |
| `INVALID_PAYLOAD` | Command固有payloadの形式不正、必須不足、余分なfield。 |
| `UNKNOWN_COMMAND` | Game processorにhandlerが登録されていないCommand。 |
| `GAME_NOT_FOUND` | 指定Gameが存在しない、またはprocessorに登録されていない。 |
| `GAME_NOT_PLAYING` | Gameが操作可能なPLAYING状態ではない。 |
| `PLAYERS_NOT_CONNECTED` | いずれかのPlayerが切断中。 |
| `FORBIDDEN` | 実行者に対象操作の権限がない。 |
| `CARD_NOT_FOUND` | Game内に対象カードがない。 |
| `ZONE_NOT_FOUND` | Game内に対象Zoneがない。 |
| `SAME_ZONE` | 移動元と移動先が同一Zone。 |
| `INVALID_DESTINATION` | カード所有権上、移動先にできないZone。 |
| `INVALID_POSITION` | 移動先Zoneに対してposition / insertIndexの指定が不正。 |
| `INVALID_INDEX` | Zone内の挿入位置が範囲外、または整数でない。 |
| `INVALID_ZONE` | その操作が対象Zoneでは許可されない。 |
| `INVALID_AMOUNT` | amountが操作条件を満たさない。 |
| `COUNTER_UNDERFLOW` | 現在値を超えるCounterを削除しようとした。 |
| `INVALID_CONTROLLER` | Controller変更先がGameのPlayerでない、または対象がBattlefield上にない。 |
| `INVALID_VISIBILITY` | 対象Zoneで許可されないVisibility。 |
| `INVALID_TURN_POSITION` | Phase / Stepの組合せが不正、またはEndTurnの条件を満たさない。 |
| `INVALID_STATE` | GameState内部の整合性が失われている。 |
| `INVALID_STATE_TRANSITION` | handlerが不正なGameState遷移を返した。 |
| `INVALID_RANDOM_SOURCE` | Shuffle用乱数源が無効なindexを返した。 |
| `INTERNAL_ERROR` | 予期しないhandler / Event処理エラー。詳細はクライアントへ含めない。 |

`commandId`が欠落または無効で結果を対応付けられないEnvelopeは、CommandResultを返せない。Transport層は`InvalidCommandEnvelopeError`をprotocol errorとして処理し、通常のGame操作として続行しない。

`INVALID_STATE`、`INVALID_STATE_TRANSITION`、`INVALID_RANDOM_SOURCE`、`INTERNAL_ERROR`は通常の利用者操作ではなく、実装・状態不整合を示すコードである。レスポンスに内部例外メッセージやstack traceを含めない。

### HTTP errorCode / status code

HTTP APIのerror bodyは一般API・管理APIで共通とし、`{ error: { code, message } }` を返す。現在のAPI仕様に対する基本codeとstatusを次のように固定する。

| HTTP status | errorCode |
| --- | --- |
| 400 | `INVALID_REQUEST`, `INVALID_PAGE`, `INVALID_IMAGE_URL` |
| 401 | `UNAUTHENTICATED` |
| 403 | `FORBIDDEN` |
| 404 | `NOT_FOUND`, `CARD_DEFINITION_NOT_FOUND` |
| 409 | `CARD_DEFINITION_ID_ALREADY_EXISTS`, `CARD_DEFINITION_VERSION_CONFLICT`, `REQUEST_ID_CONFLICT` |
| 409 (Room API) | `ACTIVE_ROOM_EXISTS`, `ROOM_NOT_WAITING`, `ROOM_FULL`, `ROOM_IN_MATCH`, `MATCH_NOT_ACTIVE`, `GAME_STILL_ACTIVE`, `GAME_NOT_ACTIVE`, `ALL_GAMES_COMPLETE` |
| 403 (Room API) | `FORBIDDEN` |
| 404 (Room API) | `ROOM_NOT_FOUND`, `PLAYER_NOT_IN_ROOM`, `DECK_NOT_FOUND` |
| 400 (Room API) | `DECK_INVALID`, `CARD_UNAVAILABLE` |
| 413 | `PAYLOAD_TOO_LARGE` |
| 500 | `INTERNAL_ERROR` |

Room lifecycle API 固有の追加対応：`DECK_INVALID`, `CARD_UNAVAILABLE` は400、`ROOM_NOT_FOUND`, `PLAYER_NOT_IN_ROOM`, `DECK_NOT_FOUND` は404、`ACTIVE_ROOM_EXISTS`, `ROOM_NOT_WAITING`, `ROOM_FULL`, `ROOM_IN_MATCH`, `MATCH_NOT_ACTIVE`, `GAME_STILL_ACTIVE`, `GAME_NOT_ACTIVE`, `ALL_GAMES_COMPLETE` は409とする。`FORBIDDEN`は403。該当endpoint契約は `spec/08-http-api.md` を参照。

`message`は人間向けの説明とし、内部例外詳細を含めない。Deck CRUD等、endpoint自体が未確定のAPI固有codeは、そのAPIを実装する際に追加する。HTTP status catalogは仕様定義であり、実装する各routeはこの対応を使用する。
