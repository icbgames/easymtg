# 09. Card Definition 管理 API

## 1. 認証・認可

- 管理 API は一般ユーザー向け API から分離する。
- 管理者認証は匿名 User Session から独立させる。
- 管理 API 全 endpoint で認証・認可を必須とする。
- 具体的な管理者ログイン方式、外部認証サービス、管理画面構成は未決定。
- 管理者の `createdBy` は Card Definition Version に保存しない。
- 専用の監査ログは設けない。必要になったら追加する。
- Status 履歴は保存せず、現在の Status のみ保持する。

## 2. Endpoint

- `POST /api/admin/card-definitions` — 新規登録
- `GET /api/admin/card-definitions` — 一覧・検索
- `GET /api/admin/card-definitions/{cardDefinitionId}` — 現在 Status と最新 Version
- `GET /api/admin/card-definitions/{cardDefinitionId}/versions/{version}` — 指定 Version
- `POST /api/admin/card-definitions/{cardDefinitionId}/versions` — 新 Version 作成
- `PATCH /api/admin/card-definitions/{cardDefinitionId}/status` — Status 変更

Version 更新と Status 変更を同時に行う原子的な管理操作も提供する。具体的 endpoint 名は実装時に確定する。

過去 Version の一覧取得 API は必要になった時点で追加する。

## 3. 一覧・検索

- 一般検索と同じ検索条件、NFKC、部分一致、sort、pagination を利用する。
- `status=ENABLED` / `status=DISABLED` で filter できる。
- status 省略時は両方を検索対象にする。
- 管理 API は DISABLED カードも検索できる。
- page size は 50 固定。

## 4. 新規登録

- `cardDefinitionId` は request で指定する。サーバー自動生成ではない。
- ID 形式は英字 3 + 数字 3。小文字は大文字に正規化する。
- 正規化後に既存 ID と重複したら `CARD_DEFINITION_ID_ALREADY_EXISTS`。
- ID は永久に再利用しない。
- 新規登録時は Version 1 を作成する。
- 初期 Status は ENABLED または DISABLED。
- Version 1 は必ず存在する。
- Card Definition 本体の物理削除 API は設けない。

## 5. Version 更新

- 1 回の更新で 1 カードのみ。
- `expectedVersion` を必須とする。
- サーバー最新 Version と `expectedVersion` が一致する場合のみ次 Version を作成。
- 不一致なら `CARD_DEFINITION_VERSION_CONFLICT`。自動で後続 Version を作らない。
- 既存 Version は不変。内容変更は新 Version として追加。
- `DISABLED` 状態でも Version 更新可能。Status を自動で ENABLED にしない。
- 同じ内容でも、更新リクエストが成功すれば新 Version を作成してよい。
- Version の手動削除 API は設けない。

## 6. Status 更新

- request は変更後の `ENABLED` / `DISABLED` を明示する。
- 同一カードへの更新を排他制御し、原子的に実行する。
- Status-only 更新では Version を増やさない。
- 現在と同じ Status の指定も成功とする（冪等）。
- Status 変更だけでは Version metadata や Status history を作らない。
- Version と Status の同時更新は原子的に処理する。

## 7. requestId（冪等性）

すべての状態変更系管理 API で `requestId` を必須とする。

- UUID 形式。
- 管理者単位で一意。
- 読み取り API では不要。
- 同一管理者・同一 `requestId`・同一 request 内容の再送は再実行せず保存済み結果を返す。
- 同一 `requestId` で内容が異なる場合は `REQUEST_ID_CONFLICT`。
- 成功・失敗のどちらも処理結果を記録する。
- Version 競合などの失敗結果も再送時には同じ結果を返す。内容を変えて再試行する場合は新しい ID を使う。
- 保存期間は再送を安全に処理できる期間を保証する。具体値と古い記録の削除方法は実装時に決定。
- 同一 requestId の同時処理でも二重実行しない。
- requestId 記録とカードマスター変更は可能な限り同一 DB transaction で確定する。
- 単一 transaction にできない処理は再送時に安全に復旧できる設計とする。

## 8. Validation

- 必須項目の欠落、型不一致、形式違反、項目間整合性違反は request 全体を失敗させる。
- ID の小文字→大文字正規化だけは明示的な例外。
- 不正値の自動補正や部分登録は行わない。
- `rulesData` はトップレベル object、未指定なら `{}`、`null` は不可。
- 重複 JSON key、JSON 外の値、深度上限超過は拒否する。
- `frontImageUrl` / `backImageUrl` は絶対 HTTPS URL として形式検証し、実際の取得確認はしない。
- リクエスト本文には最大サイズ制限を設ける。上限値は実装時に決定。超過時は HTTP 413。
- `expectedVersion` の検証が終わるまで Version を変更しない。

## 9. 成功レスポンス

- 状態変更 API は HTTP `200 OK` または `201 Created` を用途に応じて使用する。
- 成功結果は `data` フィールドにまとめる。
- 新規登録は ID、Status、Version 1 情報を返す。
- Version 更新は作成 Version と Status を返す。
- Status 更新は新 Status と最新 Version 番号を返す。
- 同時更新は作成 Version と更新後 Status を返す。
- 個別 API の完全な JSON schema は実装時に確定する。

## 10. Error format

```json
{
  "error": {
    "code": "CARD_DEFINITION_VERSION_CONFLICT",
    "message": "Card definition version conflict."
  }
}
```

- `code` は機械判定用の固定値。
- `message` は人間向け説明。
- HTTP status はエラー大分類を表す。
- 管理 API 固有のエラーも同形式。

想定コード例：
- `CARD_DEFINITION_ID_ALREADY_EXISTS`
- `CARD_DEFINITION_VERSION_CONFLICT`
- `REQUEST_ID_CONFLICT`
- `INVALID_PAGE`
- `INVALID_REQUEST`
- `CARD_DEFINITION_NOT_FOUND`
- `INVALID_IMAGE_URL`
- `PAYLOAD_TOO_LARGE`

コードの完全な一覧は実装時に shared schema とともに確定する。
