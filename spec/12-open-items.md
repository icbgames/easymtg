# 12. 未決定事項・実装時に確定する事項

この一覧は、合意済み仕様を再検討するリストではなく、現時点で具体値や実装方式が未確定の事項を集約する。

## 1. Protocol / API

- Admin APIの認証方式（単独管理者Bearer token）とVersion + Status同時更新endpointは確定・実装済み。複数管理者・権限分割は現時点の対象外。

## 2. Authentication / Session

- 複数管理者へ拡張する場合の個別identity・権限モデル。

## 3. Storage / Database

Phase 7のDrizzle schema / migration、repository実装、およびPostgreSQL integration testは完了した。現時点で追加のStorage / Database未決事項はない。運用環境のhosting / backup要件はSection 4を参照。

## 4. Limits / Runtime

- Phase 7 MVPのHTTP / WebSocket / rulesData上限は `spec/11-security-and-errors.md` で確定。
- 接続数、Rate limit、一般的な abuse protection。カード検索専用 Rate Limit は現時点では設けない方針。
- Deployment targetはAWS LightsailのUbuntu 24.04 LTSとし、PostgreSQLを同一instanceに配置する（ユーザー決定、2026-10-14）。instance size、DNS / domain、実際のTLS設定およびproduction resource構成は未確定。
- Production database backupはAWS S3へ日次保存、30日保持、RPO 24時間 / RTO 1日を目標とする（ユーザー決定、2026-10-14）。S3 bucket、IAM、lifecycleの実設定およびrestore drillは未実施。

## 5. Card rules / UI

- `rulesData` の個別 schema と、未定義 key の許容可否。
- Card Definition search に将来追加する type / cost 等の属性と filter 仕様。

## 6. Tests / Operations

- Vitest の unit / integration / end-to-end テストの具体的な構成。
- Property-based / fuzz test を導入するか。
- CI workflow、lint / formatter、typecheck の具体設定。
- Logging / metrics / tracing / alerting の設計。
- 運用環境での管理 API とAWS backup identityの秘密情報管理・rotation手順。

## 7. 決定済みなので勝手に変更しない項目

- 中央サーバー方式、常に 2 人対戦。
- Game は必ず Match に所属し、Game 1〜5 を実施。
- システムによる勝敗判定なし。
- User と Player は別概念。匿名 User ID を利用。
- Zone は 6 種類、Game あたり 11 Zone。
- Mainboard 保存・使用条件は 60 枚以上。
- Sideboard は 0〜15 枚。
- 専用の裏面がないカードも裏向きにできる。
- カードが戦場を離れた場合、Controller は Owner に戻る。
- Card Definition ID は先頭3文字がASCII英数字、後半3文字が数字で、英字を大文字に正規化後永久に再利用不可。
- Card Definition Version は不変。Game 開始時に各 CardInstance へ固定。
- Game Event sequence は Game ごと、eventId は全体一意。
- Command は Game ごとに直列処理。失敗 Command は後続を止めない。
- ViewState は Canonical GameState 外で、Game sequence を消費しない。
- WebSocket / DBのメッセージ順序、同期境界、transaction、論理table、cleanup契約は `spec/04` / `spec/10` を正とする。
- DISABLED カードを Deck から自動削除しない。
- Deck CRUD endpoint、payload、error code/status mapping、および一般Card Definition詳細・固定Version取得APIは `spec/08-http-api.md` で確定。
- Battlefieldは左上原点(0,0)、右向きx・下向きy、負座標不可、重なり可。auto-placeは左上から8列のrow-major探索。
- Life change amount 0 は`INVALID_AMOUNT`で拒否。Game画面は+1 / +5 / -1 / -5の4ボタン。
- PC操作を対象とし、Game画面は左Zone / Life、中央Hand / Battlefield、右System logの3カラム。カード裏面と画像placeholderはローカルSVGを使う。
- Sideboardは直前Game Snapshot基準のMatch内一時変更で、双方が確定後に次Gameを開始する。
- 相手切断中はGame操作を無効化し、再接続を待つ。Match終了後は勝敗を判定せずRoom参加画面へ戻る。
- 画像は外部 URL 参照、HTTPS のみ、サーバー proxy なし。
- Phase 7 MVP Session / Cookie、一般Card Definition search query名・encoding、HTTP / WebSocket / rulesData上限は `spec/11-security-and-errors.md` および `spec/08-http-api.md` で確定。
