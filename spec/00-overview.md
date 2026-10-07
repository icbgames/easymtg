# 00. 概要・アーキテクチャ

## 1. 目的

EasyMTG は、ブラウザ上で動作する常時 2 人対戦のテーブルトップ型カードゲームシステムである。プレイヤーがカードの配置・移動・タップ・表裏・カウンター・ターン位置などを手動操作し、ゲームルールによる勝敗判定をシステムに強制させずに進行できることを主目的とする。

ゲーム仕様の詳細は `gamespec` を参照する。本仕様は技術面を定義する。

## 2. 基本方針（確定）

- Web ブラウザの UI を利用する。
- 中央サーバー方式とし、P2P 方式は採用しない。
- サーバーが Canonical GameState を保持する。
- クライアントは状態変更を直接確定せず、Command を送信する。
- 常に 2 人対戦とし、将来の多人数対戦は設計対象外とする。
- ゲームルール上の勝敗判定はサーバーで行わない。
- Game は必ず Match に所属し、単独 Game は存在しない。
- Match は Game 1〜5 を順に実施する。先に 3 勝していても Game 4・5 を省略しない。
- Match の勝敗はシステム管理しない。
- Room は Match 終了時に自動削除する。
- Game 終了後の GameState は Match 終了まで保持する。

## 3. 採用技術・構成

合意済みの基本技術：

- Node.js / TypeScript
- React / Vite
- Fastify
- WebSocket
- PostgreSQL
- Drizzle ORM
- Zod
- pnpm
- Docker
- Vitest
- Monorepo

推奨ディレクトリ構成：

```text
apps/
  web/          # React + Vite のブラウザ UI
  server/       # Fastify、WebSocket、HTTP API
packages/
  shared/       # 共通型、Zod schema、protocol 定義
  game/         # GameState、Command 検証、状態遷移、View 変換
database/       # migration / schema 関連
docker/         # 開発・実行環境
spec/           # 技術仕様
```

パッケージの依存方向・具体的な workspace 設定は実装設計時に確定する。

## 4. 責務分担

### サーバー

- User セッションの識別
- Room / Match / Game のライフサイクル
- Canonical GameState の保持と更新
- Command の認証・認可・入力検証
- Game Event の生成、sequence 管理、保存、配信
- プレイヤー別 GameStateView / Event View の生成
- ViewState の管理
- Deck / Card Definition の検証
- 再接続時の状態同期
- 管理 API の認証・認可

### クライアント

- UI と入力操作
- Command の送信
- CommandResult と Event による表示更新
- 自分向け GameStateView の表示
- Hidden Card の秘匿情報を推測・補完しない
- 画像 URL からカード画像を直接読み込む
- 表示専用の UI 状態を管理する

## 5. 用語

- **User**: サイト利用者。匿名 User ID で識別する。
- **Player**: Room / Match / Game に参加する役割。User とは別概念。
- **Session**: WebSocket 等で接続している個々のクライアント接続。
- **Room**: 2 人が対戦するための部屋。
- **Match**: Game 1〜5 からなる対戦全体。
- **Game**: 1 回分のゲーム。
- **GameState**: サーバーが保持する完全な正規状態。
- **GameStateView**: 各プレイヤーに見せるために秘匿情報を加工した状態。
- **Command**: クライアントから要求する操作。
- **Game Event**: GameState の確定変更を表すイベント。
- **Lifecycle Event**: Room / Match / Game のライフサイクル通知。Game sequence を持たない。
- **ViewState**: ライブラリ閲覧等の一時的なプレイヤー別閲覧状態。Canonical GameState の一部ではない。
- **Card Definition**: カード固有情報の定義。
- **Card Definition Version**: 不変のカード情報バージョン。
- **Card Instance**: Game 中に存在する個々のカード。

## 6. 原則

- `GameState` と UI 専用状態を混在させない。
- 共有される状態変更はサーバーが確定し、Event で通知する。
- 非公開情報はサーバー側でプレイヤーごとにマスキングする。
- Game Event、Lifecycle Event、View Notification、CommandResult を混同しない。
- 実装時に仕様の未決定事項を暗黙に決めない。
