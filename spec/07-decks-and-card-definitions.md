# 07. Deck / Card Definition / Version / Image

## 1. Card Definition ID

- `cardDefinitionId` は管理者が登録時に指定する。
- 形式は英大文字 3 文字 + 数字 3 桁（例 `ABC001`）。
- 入力が小文字を含む場合、サーバーは登録前に大文字へ正規化する。
- 正規化後に重複していれば `CARD_DEFINITION_ID_ALREADY_EXISTS`。
- ID は一度使ったら永久に再利用不可。
- Card Definition 自体は物理削除しない。不要なカードは DISABLED にする。

## 2. Card Definition Status

- `ENABLED` / `DISABLED` の 2 状態。
- Status は Card Definition の現在状態で、Version 固有ではない。
- Status 変更だけでは新 Version を作成しない。
- ENABLED に戻す場合は既存の最新 Version を使う。
- DISABLED 中の既存 Game は影響を受けず、固定 Version で継続する。
- 新規 Room / Game の利用検証では DISABLED を拒否する。
- Deck 内の DISABLED カードを自動削除しない。既存 Deck は表示・編集可能だが新規利用検証は失敗する。

## 3. Card Definition Version

各 Version は不変。内容変更時は新しい整数 Version を作成し、既存 Version を上書きしない。

Version ごとの情報：

- `cardDefinitionId`（必須）
- `version`（必須。初回 1、カード ID ごとに整数で増加。欠番可）
- `englishName`（必須）
- `japaneseName`（任意）
- `hasBack`（必須）
- `backName`（`hasBack=true` のとき任意）
- `frontImageUrl`（必須）
- `backImageUrl`（`hasBack=true` のとき必須）
- `createdAt`（必須、サーバー設定）
- `changeDescription`（任意）
- `rulesData`（任意入力、保存・返却時は常にオブジェクト）

整合性：
- `hasBack=false` の場合、`backName` / `backImageUrl` は省略または null。
- `hasBack=true` の場合、`backImageUrl` は必須。
- `hasBack=true` で `backName` が null でもよい。
- `hasBack=false` で `backName` を指定した場合は不正。
- 英語名・日本語名・裏面名・画像 URL・その他カードの意味や表示に影響する情報を変更する場合は新 Version。
- Status 変更だけなら Version を増やさない。
- `createdBy` は保存しない。
- `changeDescription` は任意で、差分説明を必須にしない。

## 4. rulesData

- トップレベルは JSON object のみ。
- 省略時は `{}`。`null` は不可。レスポンスでは常に object を返す。
- 内部は JSON 標準の値を許可する（文字列、有限数値、真偽値、null、配列、object）。
- `NaN`, `Infinity` 等、JSON として表現できない値は不可。
- オブジェクトのキーは文字列。
- JSON オブジェクトのキー順序に意味を持たせず、サーバーは順序維持を保証しない。
- 配列の要素順序は意味を持つため維持する。
- 文字列は Unicode として扱い、サーバー側で NFKC 等の自動正規化をしない。
- 同一 object 内の重複キーは入力エラー。後の値で上書きしない。
- ネスト深度には上限を設ける。具体値は実装時に決定。
- 具体的な keys / schema / 値の制約はルール実装設計時に決定。
- 未定義 key を許容するかは、schema 定義時に決定。
- Version 更新では rulesData が同じでも新 Version を作成してよい。重複内容を理由に拒否・統合しない。

## 5. Version の解決・保持

- Deck Snapshot は構成 ID のみを保持し Version を持たない。
- Game 開始時に各 ID を最新 Version に解決し、CardInstance の `cardDefinitionVersion` に固定する。
- Game 中は最新 Version へ切り替えない。
- 同一カードの Version 番号は 1 から増加する整数。`(cardDefinitionId, version)` が識別子。
- Version 更新は 1 カードずつ行う。複数カード一括原子的更新はしない。
- 同じカードに対する同時 Version 更新は排他制御する。
- 更新リクエストの `expectedVersion` が最新 Version と一致しなければ `CARD_DEFINITION_VERSION_CONFLICT`。自動で新 Version を追加しない。
- Version 更新と Status 更新の同時操作は原子的に処理する。
- Status-only 更新は Version を増やさない。
- 古い Version は Active Game から参照されている間保持する。
- Active Game から参照されなくなった古い Version は非同期クリーンアップ可能。削除直前に参照を再確認する。
- 最新 Version は常に保持する。
- 手動 Version 削除 API は設けない。Card Definition 自体も物理削除しない。
- Game 終了後、古い Version が Active Game から参照されなければ Match 終了を待たず削除可能。
- Replay / 永続履歴が必要になった場合は別途履歴スナップショット設計が必要。

## 6. 画像

- 画像は EasyMTG 外部に保存し、EasyMTG は画像 URL を保持する。
- `frontImageUrl` は必須、`backImageUrl` は `hasBack=true` の場合必須。
- `hasBack=false` なら `backName` / `backImageUrl` は省略または null。
- URL は絶対 HTTPS URL のみ許可。HTTP / data / blob / その他 scheme は拒否。
- 登録時に URL の実リソースを取得確認しない。URL 形式のみ検証する。
- EasyMTG サーバーは画像を proxy せず、クライアントが URL から直接取得する。
- URL は Version 固有。URL 変更には新 Version が必要。
- 外部保管先では、原則として同一 URL の画像を置き換えない運用を前提とする。
- EasyMTG は URL の定期監視を行わない。必要に応じ管理者が確認する。
- 表面画像の読込失敗時は共通 placeholder、裏面画像の読込失敗時は共通カード裏面を表示する。
- 画像読込失敗はゲーム操作を妨げず、Version を自動変更しない。
- EasyMTG は画像ファイルを upload / storage しないため、独自の画像サイズ・形式制限は設けない。

## 7. Deck 検索・並び替え

- 検索対象：`cardDefinitionId`, `englishName`, `japaneseName`。将来、type / cost 等を拡張可能。
- 文字列検索は部分一致・大文字小文字区別なし。
- クエリは前後空白を trim、連続空白は区切り、半角・全角空白の両方で分割。
- NFKC 正規化をクエリと検索対象名に適用する。保存済み名前自体は変更しない。
- 複数語は AND。各語は ID / English / Japanese のいずれかに部分一致すれば一致。
- 最大 100 文字（NFKC 後）。超過時は共通 HTTP API error。
- 空文字は ENABLED カード全件を検索対象とする（フィルター適用後）。
- 既定 sort は `englishName ASC, cardDefinitionId ASC`。
- sort / order は whitelist。複数 sort に対応。
- Server-side filtering 後に pagination。
- page number は 1 から。1 ページ 50 件固定。client は limit を指定できない。
- response は `items`, `page`, `pageSize`, `totalCount`, `totalPages`。
- 0 件なら `totalCount=0`, `totalPages=0`。
- 範囲外 page は空 `items` と実際の total を返す。page=0 / 負数 / 非数は request error。
- 検索条件・filter・sort の変更時は client page を 1 に戻す。
- 自動検索は debounce 300ms を基本とし、古い検索結果が新しい結果を上書きしないようにする。
- 検索結果をブラウザで長期 cache しない。サーバー cache は Master 更新時に無効化できる場合のみ可。
- Card search API は匿名 User ID Session を要求する。
- 検索結果には最新 Version の全フィールド、`version`、現在 `status` を含める。通常検索では ENABLED のみ。管理検索では DISABLED も検索可能。
- `version` は参照情報であり Deck に保存しない。Game 開始時にサーバーが解決する。
