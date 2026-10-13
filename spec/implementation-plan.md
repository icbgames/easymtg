# EasyMTG 実装計画

## 1. 目的

本書は、EasyMTG のゲーム仕様および技術仕様に基づき、実装の順序、各段階の作業範囲、完了条件、検証方法を定義する。

本書は実装作業の進行管理を目的とする。個々の機能の詳細な振る舞い、データ構造、API、通信プロトコル等は、関連する仕様書を正とする。

## 2. 参照する仕様書

実装開始時には、以下の文書を確認すること。

* `AGENTS.md`：AIによる開発作業の共通ルール
* `spec/README.md`：技術仕様書の目次および参照順序
* `spec/00-overview.md`：システム全体の概要と技術構成
* `spec/01-domain-model.md`：ドメインモデル
* `spec/02-game-state.md`：ゲーム状態
* `spec/03-commands-events.md`：コマンドとイベント
* `spec/04-websocket-protocol.md`：WebSocketプロトコル
* `spec/05-room-match-lifecycle.md`：Room・Match・Gameのライフサイクル
* `spec/06-view-state.md`：プレイヤーごとの表示状態
* `spec/07-decks-and-card-definitions.md`：デッキとカード定義
* `spec/08-http-api.md`：HTTP API
* `spec/09-admin-api.md`：管理者向けAPI
* `spec/10-persistence-and-cleanup.md`：永続化とクリーンアップ
* `spec/11-security-and-errors.md`：セキュリティとエラー処理
* `spec/12-open-items.md`：未決定事項

上記は現時点の文書構成を前提とする。実装開始時に実際のファイル構成を確認し、存在しない文書や名称が変更された文書があれば、本書を更新すること。

ゲームの振る舞いについては、リポジトリに存在するゲーム仕様書を参照する。

## 3. 実装の基本方針

### 3.1 段階的な実装

* 実装はフェーズ単位で進める。
* 各フェーズの完了条件を満たしてから、原則として次のフェーズへ進む。
* 各フェーズでは、実装、テスト、必要なドキュメント更新をまとめて行う。
* フェーズ内の作業は、検証可能な小さな単位に分割する。
* 後続フェーズに影響する設計上の問題を発見した場合は、問題を整理して報告する。

### 3.2 仕様との整合性

* 実装は確定済みのゲーム仕様および技術仕様に従う。
* 未決定事項を独断で確定しない。
* 実装上の都合だけを理由として、仕様を変更しない。
* 仕様の変更が必要な場合は、理由、影響範囲、変更案を提示し、承認後に関連文書を更新する。

### 3.3 実装順序の調整

本書は初期計画であり、詳細な依存関係の確認によって順序を調整してよい。

ただし、順序を変更する場合は、変更理由、影響範囲、前提条件を説明すること。

## 4. フェーズ一覧

| フェーズ | 内容                | 完了の目安                 |
| ---- | ----------------- | --------------------- |
| 0    | 仕様・リポジトリの確認       | 実装開始に必要な前提が整理されている    |
| 1    | 開発環境・プロジェクト基盤     | ローカルで開発・テストを実行できる     |
| 2    | 共通型・ドメインモデル       | 主要な型とモデルを定義できている      |
| 3    | ゲーム状態・ゲーム操作       | ゲーム状態の変更をサーバー側で検証できる  |
| 4    | コマンド・イベント処理       | 操作結果をイベントとして管理できる     |
| 5    | 表示状態・非公開情報        | プレイヤーごとの公開範囲が正しく制御される |
| 6    | デッキ・Room・Match管理  | 対戦開始までの一連の流れを扱える      |
| 7    | 永続化・WebSocket・再接続 | サーバーとブラウザ間で状態を同期できる   |
| 8    | ブラウザUI            | 主要な操作を画面から実行できる       |
| 9    | 統合テスト・品質改善        | 主要な対戦シナリオを通して検証できる    |
| 10   | 運用・デプロイ準備         | 本番環境への配置に必要な準備ができている  |

フェーズ0で実際の依存関係と未決定事項を確認し、必要に応じてフェーズの統合・分割・順序変更を行う。

## 5. 各フェーズの実施内容

### フェーズ0：仕様・リポジトリの確認

#### 実施内容

* リポジトリの現状と既存ファイルを確認する。
* ゲーム仕様と分割された技術仕様を確認する。
* 未決定事項を整理する。
* 最初の実装に影響する未決定事項を特定する。
* 仕様書間の矛盾、重複、不足を確認する。
* 実装順序と依存関係を確認する。

#### 完了条件

* 正本とする仕様書が明確になっている。
* 初期実装に必要な仕様が把握できている。
* 実装を阻害する未決定事項が整理されている。
* 最初の実装タスクを具体的に定義できている。

### フェーズ1：開発環境・プロジェクト基盤

#### 実施内容

* pnpm によるモノレポ構成を整える。
* Node.js および TypeScript の開発環境を設定する。
* React・Vite によるフロントエンドの基盤を作る。
* Fastify によるバックエンドの基盤を作る。
* 共通型・共通処理の配置方針を整える。
* Vitest によるテスト環境を設定する。
* Lint、型チェック、ビルドの実行方法を整える。
* 必要に応じて Docker によるローカル開発環境を用意する。
* 開発手順と必要な環境変数を文書化する。

#### 完了条件

* 定義されたコマンドで開発サーバーを起動できる。
* フロントエンドとバックエンドをビルドできる。
* テストを実行できる。
* 型チェックとLintを実行できる。
* 新しい開発環境を構築する手順が明確になっている。

### フェーズ2：共通型・ドメインモデル

#### 実施内容

* User、Player、Room、Match、Game 等のモデルを整理する。
* Card Definition と Card Instance を区別して実装する。
* Deck とデッキのスナップショットを扱うためのモデルを整える。
* ゲーム状態と画面表示専用の状態を区別する。
* 共通の型定義と入力検証の方針を整える。
* サーバー側で利用するドメインモデルを実装する。

#### 完了条件

* 主要なドメインモデルが型として表現されている。
* モデル間の責務と関係が明確になっている。
* 基本的な生成・検証処理のテストがある。
* 後続のゲームロジックから利用できる状態になっている。

### フェーズ3：ゲーム状態・ゲーム操作

#### 実施内容

* サーバー側で正本となる GameState を実装する。
* PlayerState、Zone、Card Instance 等を実装する。
* ゲーム開始時の初期状態を構築する。
* カードの移動、タップ状態、表裏、公開範囲、カウンター等の操作を実装する。
* ゾーンの順序やカードの所有者・コントローラーを適切に管理する。
* 不正な操作を検証し、状態の整合性を維持する。

#### 完了条件

* 主要なゲーム状態を生成・変更できる。
* 確定済みのゲーム仕様に従って操作の可否を検証できる。
* 不正な操作によって不整合な状態が生成されない。
* 主要な状態変更処理について単体テストがある。

### フェーズ4：コマンド・イベント処理

#### フェーズ境界

* 本フェーズはGame内processorを対象とする。Sessionから解決済みのgameId / actorPlayerIdを受け、入力検証、Game単位の直列化、権限・状態検証、Canonical GameState / Event / sequence のメモリ上確定、CommandResult生成までを実装する。
* WebSocket SessionからのUser / Player / Room / Game特定、Player接続集約、メッセージ配信・順序保証、DB永続化はPhase 7。Player別GameStateView / Event maskingとViewState処理はPhase 5。本フェーズのCanonical Eventは内部用で、クライアントへ直接送らない。
* 本フェーズの重複再送は、Game・実行者・Command type・payloadが同じ場合に限り以前の結果を返す。同一commandIdの異なる要求は`COMMAND_ID_CONFLICT`で拒否する。

#### 実施内容

* クライアントからの操作要求をコマンドとして扱う。
* コマンドの入力検証と権限確認を実装する。
* ゲーム状態を変更する処理と、操作要求を受け付ける処理を適切に分離する。
* 状態変更の結果をイベントとして表現する。
* イベントのシーケンス番号と一意な識別子を管理する。
* commandId による重複処理の防止を実装する。
* コマンドの成功・失敗結果を定義された形式で返す。

#### 完了条件

* 有効なコマンドが仕様に従って処理される。
* 無効なコマンドが適切に拒否される。
* イベントによって状態変更を追跡できる。
* 重複したコマンドによる二重実行を防止できる。
* コマンド処理の順序とエラー時の挙動がテストされている。

**完了（2026-10-09）**：既定の16 Game操作Command、固定errorCode、冪等性とcommandId衝突拒否、Game単位の直列処理、Canonical Event / sequence生成をprocessorへ接続し、異常時に状態・sequenceが不変であることをテストした。Player向けmasking、ViewState、Session / WebSocket、DB永続化は後続Phaseの責務として切り分け済み。

### フェーズ5：表示状態・非公開情報

#### 実施内容

* サーバーの完全なゲーム状態から、各プレイヤー向けの GameStateView を生成する。
* 相手の手札やライブラリー等の非公開情報を適切に隠す。
* カードの枚数など、公開が許可されている情報は必要に応じて提供する。
* ViewState による一時的な閲覧状態を実装する。
* プレイヤーごとの情報公開範囲を検証する。

#### フェーズ境界

* Phase 5はGameStateView生成、Canonical EventのPlayer別masking、ViewStateのメモリ管理と5種Command、通知payload生成・reconnect sync生成、および情報漏えいテストまでを対象とする。
* 通知/EventをWebSocketへ実際に配信する処理、Session切断時の状態集約、ViewState / GameState / Eventの永続化はPhase 7。Phase 5は通知をrecipient付きデータとして返す。

#### 完了条件

* 各プレイヤーに許可された情報だけが提供される。
* 非公開カードの識別情報が意図せず漏洩しない。
* 一時的な閲覧状態と正本のゲーム状態が混同されない。
* 情報漏洩を検出するテストがある。

**完了（2026-10-09）**：GameStateViewのzone / visibilityベースの識別情報masking、Canonical Event Viewのprivate card ID / definition ID除去、5種のViewState Commandと通知 / sync生成を実装した。情報漏えい、selection/order、Confirm、stale source、Cancel、replacement、Game終了、複数Viewer syncをテストした。実配信、Session集約、DB永続化はPhase 7。

### フェーズ6：デッキ・Room・Match管理

#### 実施内容

* デッキの作成、編集、保存、検索を実装する。
* カード定義の参照とデッキの検証を実装する。
* Room の作成、参加、状態管理を実装する。
* Match と Game のライフサイクルを実装する。
* 対戦開始時にデッキのスナップショットを作成する。
* Game の終了、Match の終了、Room の削除を実装する。
* 確定済みのルールに従って、Game 1 から Game 5 までを管理する。

#### 完了条件

* 有効なデッキを保存し、Room の作成・参加に利用できる。
* 不正なデッキで対戦を開始できない。
* 対戦開始時のデッキ内容が適切に固定される。
* Room、Match、Game の状態遷移が仕様に従っている。
* 終了条件とクリーンアップがテストされている。

### フェーズ7：永続化・WebSocket・再接続

本フェーズの設計正本は `spec/04-websocket-protocol.md` と `spec/10-persistence-and-cleanup.md`。Session / CookieとHTTP・WebSocket・rulesDataのMVP上限はユーザー承認を得て `spec/11-security-and-errors.md` に確定した。Deck CRUDとAdmin認証等の未決定HTTP APIは本フェーズで追加せず、既存の確定APIに範囲を限定する。

#### 実施内容

1. **DB基盤**：Drizzle schema / migrationを作成し、PostgreSQL integration test環境とrepositoryを整える。
2. **永続ドメイン処理**：Session / Deck / Room / Match / Gameを保存し、Room join・Game開始・Game command・Match cleanupのtransactionとrow lockを実装する。
3. **Command永続化**：GameState、Canonical Event、sequence、CommandResult、ViewStateのatomic commit、commandId重複・競合処理、Event retentionを実装する。
4. **HTTPとSession**：匿名Session認証・Cookieと未実装HTTP APIの仕様を確定し、HTTP routeをrepositoryへ接続する。Admin APIは別認証を接続する。
5. **WebSocket基盤**：`/ws`認証、Hello / Welcome、protocol v1 schema、複数Session集約、FIFO受信・送信queue、heartbeatを実装する。
6. **同期・配信**：Room / Match / GameStarted lifecycle配信、CommandResult / Player別Event配信、差分Event replay / InitialState / ViewStateSyncとsnapshot中bufferを実装する。
7. **切断・cleanup**：最後のSession切断から再接続猶予を管理し、30分経過時のABANDONED、再接続、Match / Room / Game cleanup、Card Version cleanupを実装する。
8. **統合検証**：2 Client、複数Session、同一Game concurrent command、Server restart後の復元、送信失敗後reconnect、duplicate command、Game 1〜5 lifecycleをPostgreSQL付きで検証する。

#### 完了条件

* 定義された API と通信プロトコルに従って通信できる。
* 複数のクライアント間でゲーム状態を同期できる。
* 切断後に仕様に従って再接続・状態同期できる。
* 永続化と復元に必要な処理が検証されている。
* 通信エラーや異常なメッセージを適切に処理できる。

**進行中（2026-10-09）**：Protocol v1の共有Zod schemaとSession / Cookie・入力サイズ上限のMVP仕様、rulesDataの検証を追加した。PostgreSQL基盤 / migration / repository、HTTP Session接続、WebSocket transport / 同期 / cleanup、PostgreSQL統合検証は未実装のためPhase 7は未完了。これらを完了・検証するまでPhase 8には進まない。

**進捗（2026-10-10）**：Server workspaceへDrizzle ORM / PostgreSQL driver / migration CLIを追加し、`database/migrations`を出力先とするDrizzle schema、明示実行migration runner、初回migrationを作成した。論理schemaの18 table、主なunique / check / index / FK、およびCard Definition current Version・Room/Match循環参照・Room Owner参加者整合性のdeferred constraintを含む。ルート`.env`を読むmigration runnerがユーザー設定PostgreSQL上で成功し、実接続を確認した。匿名Session Repository（CSPRNG token発行、DB上のSHA-256 hash、30日sliding expiry、期限切れbatch cleanup）、sliding Cookie refresh、保護HTTP route用Session guard、PostgreSQL-backed一般Card Definition検索Repository / `GET /api/card-definitions`を実装した。SessionおよびCard Definition RepositoryのPostgreSQL統合テスト3件、Server unit / app test 13件、Shared tests 16件が成功し、Server型チェック・build・Lintも成功した。Session初回発行の一般Web page統合、永続Game / Room / Match lifecycle、Game Command atomic persistence、WebSocket transport / sync / reconnect、cleanup worker、全シナリオのPostgreSQL統合検証は未実装で、Phase 7は継続中。Deck CRUD / Admin認証は未決定仕様のため対象外。

**進捗（2026-10-11）**：GameRepositoryでGameStateの整合性検証付き復元、Game row lock、global commandId advisory lock、CommandResult冪等性、GameState / Canonical Event / Player別Event View / ViewState / CommandResultのtransactional保存を実装した。PostgresGameCommandPersistenceを既存GameCommandProcessorの永続化境界へ接続し、DB commit前にメモリ状態を変更しないようにした。DB失敗は操作失敗receiptへ変換せず、再送可能な例外として伝播する回帰テストを追加した。PostgreSQL統合テストでは同時同一Commandのcommit/duplicate、競合ID、Server processor再生成後の状態復元・同一Command再送を確認した。Game package tests 27件、PostgreSQL tests 5件、Server typecheck / lint / build が成功。

#### Phase 7 残タスク整理（2026-10-11）

| 項目 | 状態 | 残作業 |
| --- | --- | --- |
| 1. DB基盤 | 完了 | Drizzle schema / migration、PostgreSQL connection、Repositoryおよび実DB統合検証済み。 |
| 2. 永続ドメイン処理 | 完了 | Deck明示保存/get/list、Room create/join/WAITING leave/owner移譲/次Game Deck選択、Match/Game1・Game2〜5開始transaction、GameState / Snapshot / Version refs初期化を実装。HTTP入口を接続しPostgreSQLでGame 1とGame 2の初期化を検証。 |
| 3. Command永続化 | 完了 | PostgreSQL adapterをWebSocket processorへ接続し、Player認可、Room直列化、DB commit後のCommandResult / Player Event View / ViewState通知配信、重複・競合・再起動復元を実装。DB-backed 2 Session配信とwrite failure後のreplayを検証。 |
| 4. HTTPとSession | 完了（Phase 7対象） | 同一origin配信、Session発行・更新・guard、Card Definition search、およびRoom lifecycle APIを実装。Deck CRUD / Admin認証は未決定事項として対象外。 |
| 5. WebSocket基盤 | 完了 | `/ws` pre-upgrade Session認証、1MiB frame、10秒Hello、shared schema、複数Session集約、Session FIFO送信 / 受信、Pong / 30秒Ping / 60秒timeout、protocol closeを実装。実WebSocket 2 Clientのupgrade / Hello / sync / connection eventを検証。 |
| 6. 同期・配信 | 完了 | Room単位coordinator、Lifecycle / CommandResult / recipient Event fanout、Welcome後の順序、repeatable-read snapshot、差分replay / InitialState / ViewStateSyncを実装。Room lifecycle HTTP commit後の開いたSocketへのsyncを実装・検証。 |
| 7. 切断・cleanup | 完了 | 最後のSession切断集約、再接続時猶予解除、30分後のGame row lock付きABANDONED、Game 5 cleanup、Card Version / Session / Admin receipt batch workerを実装。 |
| 8. 統合検証 | 完了 | PostgreSQL repository / command restart / reconnect replay / InitialState / startup recovery / timeout / version cleanup / Game 1〜5 lifecycle、DB-backed WebSocket Commandと送信失敗後reconnect replay、および実WebSocket transportを検証。 |

この順序で項目2を先に進め、Room lifecycleの正本をPostgreSQLへ移してからWebSocket / syncへ接続する。各taskは独立して検証し、未決定HTTP APIやAdmin認証の仕様は確定させない。Phase 7完了条件を満たすまでPhase 8へ進まない。

**進捗（2026-10-11、同一origin）**：Serverは本番用Web buildを配信し、一般Web画面`GET /`でSessionを発行またはsliding expiryを更新するようにした。Vite開発ServerはHTTP APIとWebSocketをFastifyへproxyし、画面要求をFastifyへ中継してSet-Cookieを同一origin応答へ反映する。root `dev` commandはWeb buildを先に行う。初回発行・既存Session更新のFastify testを追加した。ユーザー合意に従い、`spec/11`のHTTP body / `rulesData`制限をSection 3の具体値に統一した。運用環境を含む全シナリオ確認と、Room/Match/Game永続化・WebSocket本体は引き続き未完了。

**進捗（2026-10-11、PostgreSQL同期）**：`GameSyncRepository`を追加し、Session由来UserからActive RoomとMatchを引いてRoom/Match syncを組み立て、Active Gameの連続したrecipient Event Viewが揃えば差分replayし、欠落・別Game・新規接続なら秘匿masking済みInitialStateへfallbackする。保存ViewStateがあれば最後に`ViewStateSync`を追加する。PostgreSQL統合テストで差分replayとInitialState fallbackを検証する。さらに`/ws` pre-upgrade Session認証、Hello timeout/schema検証、Welcome後の順序付き初期同期を接続した。Command処理、Player接続集約、Lifecycle通知、queue、heartbeatは未完了。

**進捗（2026-10-11、Deck / Room persistence）**：DeckRepositoryを追加し、明示保存・所有者境界・Deck schema検証・owner別get/listをPostgreSQLへ接続した。RoomRepositoryを追加し、User単位advisory lock、Deck/Card Definitionの共有lockと使用可能性検証を行うRoom作成、Room row lock下での2人目joinおよびMatch/Game1初期化callbackを一つのtransactionにまとめた。callback後にActive Match / Game 1 / GameState / Match Players / 両DeckSnapshotの永続整合を検証してからRoomをIN_MATCHへ更新する。成功commit、initializer失敗時rollback、owner越境Deck更新拒否、Active Room重複拒否、DISABLEDカード拒否をPostgreSQLで検証した。既存RoomService / MatchServiceへの実接続とGame 2〜5 / completion lifecycleは残る。

**進捗（2026-10-11、WebSocket / cleanup）**：`WebSocketSessionManager`を追加し、Session認証済みUserからPlayer / Room / Active Gameを解決、Room単位queueでHello同期とGame Commandを直列化する。複数Session集約によるPlayerConnected / PlayerDisconnected、Session別FIFO、DB commit後のCommandResult→保存済みrecipient Event View→ViewState通知配信、processor / ViewStateのDB復元、30/60秒Heartbeatを接続した。WebSocket最大frame 1MiBを設定。Server startup時に全Active Gameを切断状態として回復し、cleanup workerが30分猶予ABANDONED、Session、古い未参照Card Version、30日超Admin receiptをbatch cleanupする。RoomRepositoryにはWAITING退出/Owner移譲とMatch間Deck選択を追加した。PostgreSQLではGame1〜5開始・Game5 cleanup、ABANDONED/reconnect競合条件、startup timestamp、Version参照cleanupを検証した。実WebSocket 2 Clientでupgrade / ordered sync / connection lifecycle通知、fake socketでheartbeatと複数Sessionを検証した。Room lifecycle操作のHTTP / WebSocket入口は未定義のため`spec/12-open-items.md`に残した。

**検証結果（2026-10-11）**：workspace全体のtypecheck / lint / build / testが成功（Shared 16、Game 27、Web 1、Server 18 passed / 16 skipped）。PostgreSQL integration test 17件が成功。追加した検証は実WebSocket 2 Client Hello / ordered sync、Session集約とheartbeat、Game 1〜5永続開始・終了、restart後disconnect grace、ABANDONEDと再接続取消、recipient Event replay / InitialState fallback、Card Version cleanup。

**進捗（2026-10-11、Room lifecycle HTTP）**：HTTPを操作要求、WebSocketをLifecycle Event / Room・Match・Game同期に使う方針を確定。`spec/08`にactive Room取得、create / join / leave、between-Game Deck選択、Game 2〜5開始のendpoint・入力・応答・エラー契約を追加し、`spec/04` / `spec/11` / `spec/12`を整合させた。Fastify routeをSession guard・Zod strict validation・PostgreSQL Room/Match Repositoryへ接続し、GameInitializerがGameState / DeckSnapshot / Card Definition Version refsを各開始transactionで生成する。commit後に既存WebSocket SessionをRoomへ関連付け直し、Lifecycle Eventと現在状態のsyncをFIFOで送る。新規Roomで待機中の未接続WebSocketも再同期後にSession管理へ参加する。

**Phase 7完了（2026-10-11）**：DB基盤とrepository、Game command atomic persistence、HTTP / Session、WebSocket認証・複数Session・queue・heartbeat、差分replay / snapshot、切断猶予とcleanup、Room lifecycle HTTP entrypointsおよびWebSocket再同期を実装・検証した。Room操作のHTTP route、Game初期化・Room操作のPostgreSQL integration、DB-backed WebSocket Commandの2 Session fanout、送信失敗後のreconnect replayを確認した。Server tests 38件成功（PostgreSQL integrationを含む）、Room/Game PostgreSQL integration 15件成功、実WebSocket transport test成功。Deck CRUD / Admin認証・API、ブラウザUIはそれぞれ別仕様・後続Phaseの範囲として残る。

### フェーズ8：ブラウザUI

#### 実施内容

* Room の作成・参加画面を実装する。
* デッキの作成・編集・検索画面を実装する。
* 対戦画面と各 Zone の表示を実装する。
* カードのドラッグ＆ドロップやコンテキストメニュー等の操作を実装する。
* カードの表裏、タップ状態、カウンター等の表示と操作を実装する。
* サーバーから配信される状態とイベントを画面へ反映する。
* 接続状態、エラー、再接続等をユーザーに表示する。

**完了（2026-10-11）**：デッキ一覧・検索・編集・明示保存、Room作成・Room ID参加、Game間一時Sideboard変更と双方の確定、3カラム対戦画面を実装した。対戦UIはLifeの4ボタン、Zoneレールと権限に基づくViewState閲覧、カードの移動・自動配置・タップ/裏返し/Counter/Controller/Visibility操作、ターン操作、ログ、相手切断時の操作停止、1〜30秒の指数バックオフ再接続を含む。Server側で操作を検証し、WebSocket同期後に画面を再取得する。カード裏面・画像placeholderはローカルSVG。

React UIの画面テストでデッキ編集の未保存60枚未満条件、3カラム表示、+5 Life Commandの送出を検証した。Phase 8完了時点の検証はWeb 3 tests / typecheck / lint / production build、Server 38 tests（PostgreSQL integration・WebSocket transport含む）、Game 27 tests、Shared 16 testsが成功。PostgreSQLへSideboard confirmation migrationを適用し、Drizzle schema generationに追加差分がないことを確認した。ブラウザ実画面のsessionはlocalhost接続timeoutで取得できなかったため、視覚的なブラウザQAは未実施。主要画面操作はWebのjsdom上のReact UI testで検証済み。

#### 完了条件

* ブラウザから主要な機能を操作できる。
* UI がサーバー側の状態と整合している。
* 相手に公開されない情報が画面に表示されない。
* 主要な操作が実際の画面で検証されている。

### フェーズ9：統合テスト・品質改善

#### 実施内容

* 2人のプレイヤーによる対戦シナリオを検証する。
* デッキ作成から Match 終了までの一連の流れを検証する。
* 非公開情報の制御と通信内容を検証する。
* 不正な操作、切断、再接続、通信エラー等を検証する。
* 必要に応じて負荷、性能、セキュリティの確認を行う。
* 発見された不具合を修正し、回帰テストを追加する。

#### 完了条件

* 主要なユーザーシナリオが正常に動作する。
* 重大な不具合が未解決のまま残っていない。
* 自動テスト、型チェック、Lint、ビルドが成功する。
* 既知の制限事項が整理されている。

### フェーズ10：運用・デプロイ準備

#### 実施内容

* 本番環境の構成を整える。
* 環境変数と秘密情報の管理方法を整える。
* DBの初期化・マイグレーション手順を整える。
* ログ、ヘルスチェック、エラー監視等を整える。
* ビルド成果物の配置と更新手順を文書化する。
* バックアップや復旧など、必要な運用方針を整理する。

#### 完了条件

* 本番環境に必要な設定と手順が文書化されている。
* 本番用ビルドと起動を検証できる。
* 運用上の制約と未対応事項が明確になっている。

## 6. フェーズ完了時の共通ルール

各フェーズの完了時には、以下を確認する。

1. フェーズの実装範囲が完了している。
2. 対応する自動テストが追加され、実行されている。
3. 型チェック、Lint、ビルド等、関連する検証が実行されている。
4. 関連ドキュメントが必要に応じて更新されている。
5. 未解決の問題と未決定事項が記録されている。
6. 完了条件を満たしていることを説明できる。

検証が失敗した場合や、必要な作業が残っている場合は、その内容を明示する。未完了のフェーズを完了扱いにしないこと。

## 7. 未決定事項との連携

実装中に未決定事項が見つかった場合は、`spec/12-open-items.md` を更新対象として扱う。

ただし、仕様の決定や変更はユーザーの承認を得てから行う。

初期実装を妨げない事項は、必要になるフェーズまで保留してよい。すべての未決定事項を実装開始前に解消する必要はない。

## 8. 計画の更新

本書は開発の進行に応じて更新する。

* フェーズの順序や範囲を変更した場合は、その理由を記録する。
* フェーズを追加・分割・統合した場合は、完了条件も合わせて更新する。
* 実装済みのフェーズは、実際の検証結果に基づいて完了状態を記録する。
* 詳細な仕様を本書へ重複して記載せず、関連仕様書を参照する。

## 9. 最初に実施する作業

最初の作業はフェーズ0とする。

既存リポジトリ、仕様書、未決定事項、開発環境を確認し、フェーズ1に着手できる状態を整える。

フェーズ0の完了後、フェーズ1以降は各フェーズの範囲と完了条件を確認しながら、段階的に実装を進める。

## 10. フェーズ0確認結果（2026-10-08）

### リポジトリの現状

* `main` ブランチには仕様書のみがあり、アプリケーションコード、package manifest、テスト、開発コマンドはまだ存在しない。
* `spec/gamespec` はリポジトリに存在する。`spec/README.md` の「本パッケージには複製していない」という説明とは一致しないため、ゲーム仕様の内容は現存する `spec/gamespec` を確認した。
* 技術仕様の正本は `spec/README.md` が案内する分割仕様（`spec/00`〜`spec/12`）とする。ゲーム上の振る舞いの正本は `spec/gamespec` とする。`spec/technicalspec.md` は分割版を参照する案内文書である。

### 初期実装に必要な前提

* 採用技術は `spec/00-overview.md` 記載の Node.js / TypeScript、React / Vite、Fastify、WebSocket、PostgreSQL、Drizzle ORM、Zod、pnpm、Docker、Vitest、Monorepo。
* 推奨構成は `apps/web`、`apps/server`、`packages/shared`、`packages/game`、`database`、`docker`。workspace の依存方向、Node.js のバージョン、具体的な lint / formatter / CI 設定は未確定で、Phase 1 の基盤設計で決める。
* 最初の実装タスクは Phase 1 のプロジェクト基盤作成。pnpm workspace と Node.js / TypeScript 設定、Web・Server・Shared・Game の最小 package、Vite / React、Fastify、Vitest、型チェック・lint・build のコマンドを整え、開発手順を記す。Docker は必要性を構成確認後に判断する。

### 仕様の食い違い・不足

以下はPhase 0確認時点の仕様の食い違い。2026-10-09のユーザー判断を反映し、解決状況を更新する。

| 論点 | 記述の食い違い | 現在の決定・影響する作業 |
| --- | --- | --- |
| Sideboard 枚数 | `spec/gamespec` は 0〜15 枚、`spec/01-domain-model.md` は上限なし | 0〜15枚（gamespecが正）。仕様・実装を更新済み。Deck保存・検証（Phase 6） |
| 裏面のないカードを裏向きにする操作 | `spec/gamespec` は不可、`spec/02-game-state.md` は専用裏面がなくても可能 | 可能（技術仕様が正）。仕様・実装を更新済み。Card操作（Phase 3） |
| Waiting Room の Owner 退出 | 旧記述に Room 削除と Owner 移譲の食い違い | ユーザー決定：退出後に参加者が残る場合は最初の残存PlayerへOwnerを移譲し、残存Playerがいない場合だけRoomを削除。gamespec・技術仕様・Phase 6実装を更新済み。 |
| 2 人目参加後の開始 | `spec/gamespec` は参加で対戦開始、技術仕様は Owner が StartMatch / StartGame を要求するモデル | ユーザー決定：gamespecを正とし、2人目の入室でMatchとGame 1を自動開始。Game 2〜5はOwnerが開始する。`spec/01` / `spec/05` と実装を更新（Phase 6） |
| 相手切断中の操作 | `spec/gamespec` は 1 人しか接続していない間の操作を禁止、`spec/05-room-match-lifecycle.md` は切断相手がいても接続中 Player は通常操作可能 | ユーザー決定：いずれか一方が切断中は操作禁止。gamespecを正としspec/05とCommand仕様を更新。Phase 4で認可条件、Phase 7で接続状態連携を実装。 |

### 未決定事項の影響と次の判断時期

* `spec/12-open-items.md` の API / Protocol 完全 schema、匿名 Session と管理者認証、DB schema / transaction、各種上限、UI 詳細等は多数未決定。これらは関連する実装フェーズに着手する前に決めればよく、Phase 1 の基盤開始を妨げない。
* Phase 1 では技術仕様に沿う基盤と開発コマンドを整え、ゲーム仕様上の判断が必要な機能には着手しない。
* この確認時点ではRoom Owner退出、2人目入室後の開始、および相手切断中の操作が未解決だった。後続のユーザー判断と仕様更新はPhase 6進捗欄を参照する。

### 完了状況

* リポジトリ構成、ゲーム仕様、分割された技術仕様、未決定事項、現時点の開発環境を確認した。
* 正本、Phase 1 に進むための前提、初期実装タスク、および後続実装を阻害する仕様の食い違いを整理した。
* 以上をもって Phase 0 を完了とする。Phase 1 は本書記載の基盤作成から開始する。

## 11. フェーズ1進捗（2026-10-08）

* ルートに pnpm workspace、Node.js 24 系、pnpm 11.19.0、TypeScript 共通設定、ESLint、workspace 共通の build / test / typecheck / lint コマンドを追加した。
* `apps/web` に React / Vite の初期画面と Vitest 設定、`apps/server` に Fastify / WebSocket plugin の基盤と `/health`、`packages/shared` に Zod の共有入口、`packages/game` に後続実装用 package を追加した。
* セットアップ・開発・検証手順をルート README に記載した。ゲームロジック、ゲーム API、データベース処理はこのフェーズの対象外。
* Docker は DB 等のローカルサービスをまだ使わないため、この段階では追加していない。
* ユーザーが pnpm install を実行し、Node.js 24.21.0 / pnpm 11.19.0、lockfile、node_modules の生成を確認した。ESLint 10.12.0、@eslint/js 10.0.1、jsdom 30.1.2、Vite 8.3.3 がインストールされ、`whatwg-encoding` は lockfile からなくなった。npm registry に存在しない `@eslint/js@10.12.0` を最初に誤指定したが、公開済みの 10.0.1 に修正し、その後 install は成功した。
* install 後は sandbox の `realpath` 制約で pnpm wrapper の workspace 操作が失敗するため、インストール済み CLI を直接実行して検証した。shared / game / server / web の build、4 workspace の test（各 1 件）、typecheck、ESLint が成功。
* Fastify サーバーは `127.0.0.1:3000` で起動し、Vitest の `app.inject` health check で HTTP 200 を確認。Web 開発サーバーも `127.0.0.1:5173` で起動を確認した。sandbox が外部からのローカル socket 接続を拒否するため、HTTP クライアントによる個別疎通は未確認。
* 2026-10-08、ユーザー提供の通常端末ログによりルート `pnpm dev` が成功し、shared / game の build 後に Web（`127.0.0.1:5173`）と Server（`127.0.0.1:3000`）の両方が起動したことを確認した。
* Phase 1 の完了条件を満たした。次は Phase 2 の共通型・ドメインモデルに進める。

## 12. フェーズ2進捗（2026-10-08）

* `packages/shared` にブランド付きID、User / Player / Session / Room / Match / Game、Card Definition / Version、Deck / DeckSnapshot の Zod スキーマと推論型を追加した。
* Room の owner 参加条件・参加者重複、Card Definition の current version 参照・version 重複、画像 HTTPS・裏面メタデータの基本検証を追加した。
* `packages/game` に GameState、PlayerState、CardInstance、Zone、phase / step、counter、および GameState と分離した ViewState の型・スキーマを追加した。
* Sideboard 枚数、Match status の具体的な値、裏面のないカードを裏向きにする可否など、未決定または矛盾する仕様は制約に固定していない。GameState を変更するゲーム操作は Phase 3 の対象とする。
* shared のテスト3件、game のテスト2件、両 package の build / typecheck / lint が成功した。テストは各 package の Vitest root を指定して実行した。shared のテストは lint 修正前に実行したため、同修正後の再実行も成功確認済み。
* Phase 2 の完了条件を満たした。次は Phase 3 でゲーム状態の初期生成と状態変更操作を実装する。

## 13. フェーズ3進捗（2026-10-09）

* `packages/game` の Canonical GameState を技術仕様に合わせ、matchId / status / sequence、正規の Phase / Step、11 Zone、PlayerState の Life、CardInstance の固定 Version・Position・Counters・Visibility を持つ形に改めた。Zone 所属をカード側に重複保持せず、Zone.cardIds を正本とした。
* GameState schema に、プレイヤー・Zone・Card ID の整合性、各カードのZone所属、非戦場カードの所有者Zone、Battlefield座標、Phase / Step の組合せ等の検証を追加した。
* `createInitialGameState` を追加。2人と各60枚以上のMainboardを検証し、11 Zoneを生成、各デッキをサーバー側で暗号学的乱数によりシャッフル、各プレイヤーの上から7枚を手札へ移動、初期Life 20、ホストを先攻として Game を開始する。ID生成・乱数源を差し替え可能にしてテスト可能とした。
* 不変な状態変更関数として、カード移動・Zone内順序変更・タップ状態・Counter・Controller・Visibility・Battlefield座標・Life・Phase / Step・ターン終了・シャッフル・投了を追加した。操作前の権限や値を検証し、成功時に新しいGameStateを返す。Game Event と sequence の確定は Phase 4 の対象。
* 対応する単体テスト6件、Game package のbuild / typecheck / lintが成功した。テスト実行時にShared distの既存source map警告が出るが、テスト結果は成功。
* 当時は「裏面のないカードを裏向きにする」操作を未実装とし、Sideboard上限を適用していなかった。2026-10-09の決定に基づき、現在は裏返し操作を実装し、Sideboardを0〜15枚に制限した。
* Phase 3 の主要な状態モデル・初期生成・変更処理を完了した。`ChangeLife.amount = 0` の扱いは未決定で、現在の実装は0変更を拒否する。次はPhase 4のCommand / Event処理に進める。

## 14. 仕様差分の修正（2026-10-09）

* Card Definition Status を仕様どおり `ENABLED` / `DISABLED` に修正し、Game 初期化時に DISABLED または未解決の定義を拒否するようにした。
* Card Definition Version に `cardDefinitionId`、英語名・日本語名、裏面名、変更説明を加え、`hasBack` と裏面メタデータの整合性を仕様に合わせた。
* Deck を User 所有、Mainboard / Sideboard を Card Definition ID 配列として表現し、保存 Deck の Mainboard 60 枚以上を検証する。DeckSnapshot は仕様どおり deckId / deckName / mainboard / sideboard に合わせた。Sideboard上限は次節の2026-10-09決定で0〜15枚に統一した。
* ViewState を viewId / viewerPlayerId / viewType / sourceZoneId / viewedCardIds / optional selectedCardIds に修正した。
* Shared のテスト4件、Gameのテスト6件、および両パッケージの build / typecheck / lint が成功した。Game testではShared distのsource map警告が出るが、テスト結果は成功。

## 15. 仕様判断の反映（2026-10-09）

* ユーザー決定：専用の裏面がないカードも裏向きにできる（技術仕様を正とする）。gamespecを更新し、Game操作を実装した。
* ユーザー決定：カードがBattlefieldを離れた際にControllerをOwnerへ戻す。`spec/02-game-state.md` と移動処理を更新した。
* ユーザー決定：Sideboardは0〜15枚（gamespecを正とする）。`spec/01`、`spec/08`、共有Deck / Snapshot schema、Game初期化検証を更新した。
* ユーザー決定：どちらか一方が切断中はゲーム操作を禁止する（gamespecを正とする）。`spec/05` と `spec/03` を更新し、Phase 4のCommand処理で接続状態を認可条件に含めた。
* Sideboardの上限矛盾、裏向き可否、相手切断中の操作は解決済み。Room Owner退出は`spec/05`の存続Roomでの移譲規則を採用し、2人目入室後はゲーム仕様に従ってGame 1を自動開始する。
* ユーザー決定：Match statusは `ACTIVE` / `ENDED`。ゲームの開始はgamespecを正とし、2人目の入室でGame 1を自動開始する。Game 2〜5はOwnerが開始する。`spec/01` / `spec/05` および共有schemaに反映した。

## 16. フェーズ0〜3再確認とフェーズ4進捗（2026-10-09）

* Phase 0〜3のコード・仕様・検証記録を再確認した。Roomモデルに参加者ごとの選択Deckと、Match作成後のRoom.matchIdが不足していたため、Phase 2のモデル・テストを補完した。
* 共有型、Game、Server、WebのTypeScript build / typecheckを実行し、すべて成功した。ESLintは4 workspaceすべて成功。VitestはShared 4件、Game 11件、Server 1件、Web 1件が成功した。
* Vitestをリポジトリrootから一括起動した初回は、Web専用のjsdom設定が適用されず失敗した。各workspaceの設定で再実行し、すべて成功した。Gameのテストでは既存のShared dist source map警告が出る。
* `pnpm` CLIはsandboxのworkspace `realpath` 制約で起動できなかったため、インストール済みTypeScript / Vitest / ESLint CLIを直接呼び出した。
* Phase 4として、共有CommandEnvelope / CommandResult / GameEvent schema、Gameごとの直列処理、Command IDの冪等性、payload検証、状態遷移失敗時の不変更、成功時のCanonical Eventとsequence生成、切断中の拒否を実装した。
* Phase 4のCommand processorテスト7件が成功した。切断状態は現在processorへPlayer単位で連携するAPIまでであり、WebSocket Sessionからの接続状態集約はPhase 7で接続する。
* Phase 4は継続中。ユーザー依頼により、既定のゲーム操作CommandとViewState Commandのpayload形を仕様化し、共有Zod schemaとschemaテストを追加した。さらに、Phase 3のGame操作関数へ接続する全16 handlerとprocessor factoryを登録した。
* Game操作CommandのCanonical Event形式を `<CommandType>Applied` と `{actorPlayerId, commandPayload}` に統一した。ShuffleZoneは確定後の `cardIds` も記録する。Event契約を `spec/03` に記載し、Player別秘匿情報のmaskingはPhase 5に残した。
* handler接続テストを追加し、Shared 6件 / Game 13件のテストが成功した。Shared / Gameの型チェックとLintも成功。Game testでは既存Shared dist source map警告が出る。
* ViewState Commandはpayload schemaまで定義済み。ViewState自体の管理・handlerはPhase 5の対象のため、GameState processorには登録していない。
* Command errorCode 30種を`spec/11`とShared Zod enumで固定し、`CommandResultSchema`および`GameOperationError`で使用した。相関可能な不正Envelope、commandId衝突、未知Command、Game未登録、切断、操作エラー、ViewStateエラー、予期しない内部エラーをprocessorで返し分ける。commandIdを持たないEnvelopeはCommandResultを返せないため、専用protocol errorをthrowする。
* HTTP errorCode 12種とstatus対応を`spec/11`およびShared response schema / status mapに定義した。HTTP API自体は未実装のため、routeへの適用は各API実装時に行う。
* 今回の再検証ではShared 8件、Game 15件、Server 1件、Web 1件の合計25件が成功。4 workspaceの型チェックとLintも成功した。Gameテストでは既存Shared dist source map警告が出る。
* Phase 4完了条件を再確認し、境界内のすべての条件と衝突ケースがテストされているため完了とした。Phase 5ではPlayer別GameStateView、Eventのprivate card identity除去、ViewState 5種Command、公開/Viewer private notifications、複数Viewerのreconnect sync、stale view拒否、Game終了時の終了通知を実装した。
* Phase 5完了時の検証はGame 26件、Shared 8件、Server 1件、Web 1件の合計36件が成功。4 workspaceの型チェックとLintも成功。Gameテストで既存Shared dist source map警告あり。pnpmはsandbox realpath制約のため使わず、各workspaceでインストール済みCLIを実行した。

## 17. フェーズ6完了（2026-10-09）

* Serverに明示Deck保存・取得・一覧、Deckの使用検証、Card Definition検索、Room作成・参加・退出・Owner移譲をメモリ上のドメインサービスとして実装した。
* 2人目の入室をMatch / Game 1開始と同じ原子的な処理に接続した。Room参加の確定前に両Deckと全Card Definitionの有効性を検証し、失敗時に参加者・Room状態・Match / Gameを部分作成しない。
* Match statusを `ACTIVE` / `ENDED` に固定。Game 1〜5、GameごとのDeck Snapshot、最新Card Definition Versionの解決とCardInstanceへの固定、Game間のDeck選択（Sideboard変更）、Game終了・ABANDONED・Game 5終了時のRoomとGameState cleanupを実装した。勝敗集計は行わない。
* 次Game開始はOwnerのみ。Match内で終了Gameの最終状態を次Game開始まで保持し、各Gameを独立した初期状態として作成する。
* ServerにはCard Definition検索の`japaneseName` sortを追加し、欠損日本語名を空文字として比較、同順位時の`cardDefinitionId ASC` tie-breakを定義した。Room Owner退出は残存Playerがいれば移譲し、Roomが空になる場合のみ削除する。最新の自動開始仕様ではWAITINGはOwner 1名のみのため、移譲条件は通常フローでは到達せず、ライフサイクル仕様にその点を明記した。
* Serverテストは Deck / Room / Match / Game lifecycle を含む。Shared / Game / Webの既存テストと4 workspaceの型チェック・Lintも確認する。source map警告は既存dist mapに由来する場合がある。
* Deck CRUDのHTTP endpoint、データベース永続化、WebSocket Lifecycle Event配信は仕様・実装計画どおりPhase 7に残す。

## 18. フェーズ7設計決定（2026-10-09）

* PostgreSQL / Drizzleの論理table、FK / unique制約、JSONB適用箇所、migration運用、READ COMMITTED + row lock方針を`spec/10`に定義した。DBをGameStateの正本とし、GameState / Canonical Event / Player別Event View / sequence / CommandResultの原子的commit、ViewState永続化、Room・Match transaction、Game終了・Match終了cleanupを確定した。
* WebSocket v1はHello / Welcome、Room・Match同期、Active Gameの差分replayまたはInitialState、ViewState同期の順とし、Game IDをHelloに追加してGame間のsequence誤適用を防ぐ。複数Session、受信・送信FIFO、Game sequence順の配信、heartbeat、protocol close code、Lifecycle payloadの項目を`spec/04`に定義した。
* Event replayの秘匿性を保つためCanonical Eventに加え、commit時のGameStateから生成したPlayer別Event Viewを同一transactionで保存し、過去Eventを現在のGameStateで再maskingしない設計とした。
* 初期WebSocket配備は単一Server processとし、process間socket fanout / 水平scaleは対象外。Frame / HTTP body / `rulesData`の具体的サイズ上限、匿名Session・Cookie、未定義HTTP endpoint、production backupのRPO / RTOは関連仕様の未決事項として残す。DB schema・Repository・Protocol Zod schema・PostgreSQL統合テストはPhase 7の実装タスクであり、未決定仕様とは区別した。
