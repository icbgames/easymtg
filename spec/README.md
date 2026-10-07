# EasyMTG 技術仕様書

このディレクトリは、EasyMTG の実装仕様を機能領域ごとに分割して管理する。

## 読み始める順序

1. [`00-overview.md`](./00-overview.md) — 目的、アーキテクチャ、技術スタック、用語
2. [`01-domain-model.md`](./01-domain-model.md) — User / Room / Match / Game / Player / Deck の関係
3. [`02-game-state.md`](./02-game-state.md) — GameState、CardInstance、Zone、可視性、カウンター
4. [`03-commands-events.md`](./03-commands-events.md) — Command、Game Event、直列処理、冪等性
5. [`04-websocket-protocol.md`](./04-websocket-protocol.md) — WebSocket、Hello/Welcome、同期、再接続
6. [`05-room-match-lifecycle.md`](./05-room-match-lifecycle.md) — Room / Match / Game のライフサイクル
7. [`06-view-state.md`](./06-view-state.md) — ライブラリ閲覧等の一時的な非公開 ViewState
8. [`07-decks-and-card-definitions.md`](./07-decks-and-card-definitions.md) — Deck、Card Definition、Version、画像
9. [`08-http-api.md`](./08-http-api.md) — 一般ユーザー向け HTTP API
10. [`09-admin-api.md`](./09-admin-api.md) — カードマスター管理 API
11. [`10-persistence-and-cleanup.md`](./10-persistence-and-cleanup.md) — 永続化、履歴、クリーンアップ
12. [`11-security-and-errors.md`](./11-security-and-errors.md) — 認証、認可、入力検証、エラー
13. [`12-open-items.md`](./12-open-items.md) — 未決定事項・実装時に決める事項

ゲームの振る舞い・ユーザー体験の正本は既存の [`gamespec`](./gamespec) とする。本技術仕様書は、主にデータモデル、通信、処理、永続化、API、実装上の制約を定義する。`gamespec` は本パッケージには複製していない。

## AI 実装時の運用ルール

- 実装タスクでは、まず本ファイルと該当する仕様ファイルを読む。
- 仕様同士が矛盾する場合、勝手に推測して実装せず、矛盾箇所を報告する。
- `未決定` と明記された事項を独自判断で確定しない。
- 既存の確定仕様を変更する必要がある場合、コード変更より先に仕様変更案を提示する。
- `GameState` の正本はサーバーに置き、クライアントから直接変更しない。
- API / Protocol のフィールド名・エラーコードは、実装開始時に共有スキーマへ集約する。
- 仕様とテストを同時に更新し、正常系・異常系・権限・非公開情報の漏えいを確認する。

## ステータス表記

- **確定**: ユーザーとの合意済み仕様
- **未決定**: 後続設計または実装時に決める
- **推奨**: 実装上の推奨であり、明示的な合意が必要な場合は確認する

## 更新方針

仕様を分割したため、同じ規則を複数ファイルに重複定義しない。定義元を一つにし、他ファイルから参照する。
