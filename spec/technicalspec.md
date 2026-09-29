# カードゲームシステム 技術仕様書

## データモデル・ゲーム状態編（暫定版）

### 1. 文書概要

本仕様書は、ブラウザ上で動作する2人対戦型カードゲームシステムについて、現時点で確定しているゲーム状態・データモデル・カード状態・Zone移動等の技術仕様を定義する。

本書は実装前の仕様確定を目的とした暫定版であり、未決事項については明示的に「未決」と記載する。

---

# 2. 基本システム構成

## 2.1 想定技術スタック

現時点で以下の技術スタックを採用する。

| 項目       | 技術           |
| -------- | ------------ |
| 実行環境     | Node.js      |
| 言語       | TypeScript   |
| フロントエンド  | React + Vite |
| サーバー     | Fastify      |
| リアルタイム通信 | WebSocket    |
| データベース   | PostgreSQL   |
| ORM      | Drizzle ORM  |
| バリデーション  | Zod          |
| パッケージ管理  | pnpm         |
| コンテナ     | Docker       |
| テスト      | Vitest       |
| リポジトリ構成  | Monorepo     |

詳細なサーバーAPI、WebSocketプロトコル、DBスキーマ等は別途定義する。

---

# 3. システム上の主要概念

本システムでは、以下の概念を明確に分離する。

### User

サービス上のユーザーを表す。

匿名ユーザーを基本とし、ユーザー自身のゲーム内役割とは分離する。

### Player

特定のMatchに参加しているプレイヤーを表す。

1つのUserがMatchに参加することで、そのMatch内にPlayerとしての状態を持つ。

したがって、

```text
User
  ↓ 参加
Player
  ↓ 所属
Match / Game
```

という関係になる。

### PlayerState

特定のGameにおけるPlayerの現在状態。

### GameState

1ゲーム全体の現在状態。

### Match

2人のプレイヤーによる一連のゲームを管理する単位。

### Room

プレイヤーがMatchを開始するために利用する待機部屋。

### Card Master

カードそのもののマスターデータ。

### Card Instance

実際のGame中に存在する、個々の物理カードに相当するオブジェクト。

Card InstanceはCard Masterを参照するが、Game中の状態は独自に保持する。

---

# 4. Room / Match / Game

## 4.1 Room

Roomは最大2人のプレイヤーを収容する。

2人目のプレイヤーが参加するとMatchを開始する。

Match終了後、Roomは自動的に削除する。

したがって、Room自体はMatch終了後の履歴保持を目的としない。

### Roomの状態

詳細なRoom State enumは未決。

ただし、Match終了後にRoomを削除するため、ゲーム終了状態をRoomに長期間保持する必要はない。

---

## 4.2 Match

Matchは複数回のGameから構成される。

現時点では、最大5ゲーム程度の構成を想定している。

ただし、

* 正確なゲーム数
* Match終了条件
* Matchの勝敗管理方法

については未決。

### Matchの勝敗

サーバー/Game Serverはプレイヤーの勝敗を判定・管理しない。

プレイヤー自身が勝利・敗北の結果を管理する。

したがって、サーバー側でゲームルールから自動的にMatch Winnerを決定する仕様にはしない。

---

## 4.3 Game

GameはMatch内の1ゲームを表す。

Game Statusは以下の3種類とする。

```text
WAITING
IN_PROGRESS
FINISHED
```

### WAITING

対戦相手を待っている状態。

### IN_PROGRESS

ゲーム中。

### FINISHED

そのGameが終了した状態。

`FINISHED` はGameの状態であり、Roomの状態ではない。

Match終了後にRoom自体が削除されるため、通常のユーザー操作ではFINISHED状態のRoomが残り続けることはない。

---

# 5. User

Userはサービス上の匿名ユーザーを表す。

現時点で必要とするユーザー情報は以下。

```text
userId
displayName
```

その他のプロフィール情報は持たない。

DB上の管理のために、

```text
createdAt
updatedAt
```

等を持たせるかどうかは実装時に決定する。

---

# 6. Player

Playerは特定のMatchにおけるUserの参加者情報。

UserとPlayerは同一概念として扱わない。

概念上、

```text
User
  userId
  displayName

Player
  playerId
  userId
  matchId
  ...
```

のように分離する。

Game内のカード所有者・コントローラー等については、Playerを参照する。

---

# 7. Playerの接続状態

現時点では接続状態を以下の2種類とする。

```text
CONNECTED
DISCONNECTED
```

接続状態の詳細なタイムアウト・再接続処理等は未決。

---

# 8. Gameのターン情報

Gameは内部状態として`turnNumber`を保持する。

初期値は

```text
turnNumber = 1
```

とする。

ターンが進行するごとにインクリメントする。

ゲームルール上、特定の処理でturnNumberを参照する必要がなくても、ゲーム内部状態として保持する。

Gameはまた、

```text
activePlayerId
```

等のターン関連情報を保持する想定。

具体的なTurn / Phase / Stepの構造および値は未決。

---

# 9. Card Master

Card Masterはカードのマスターデータを表す。

最低限、以下の情報を保持する。

```text
cardId
name
frontImage
backImage
```

その他のカード固有メタデータについては未決。

---

# 10. Card Instance

Card InstanceはGame中に存在する個々のカードを表す。

Card Masterとは別に、Game中の状態を保持する。

基本構造として以下を想定する。

```text
instanceId
cardId
ownerId
controllerId
zone
face
visibility
tapState
counters
position
```

### instanceId

Game内のカードインスタンスを一意に識別するID。

カードがZone間を移動しても、原則として同一Card Instanceとして扱う。

※ Zone移動時にinstanceIdを再生成するかどうかは、正式仕様としては未決。

---

# 11. Card InstanceのOwner / Controller

Card Instanceには、

```text
ownerId
controllerId
```

を別々に保持する。

OwnerとControllerは異なる場合がある。

例えば、

```text
ownerId      = Player A
controllerId = Player B
```

という状態を許容する。

---

# 12. Card Zone

カードが存在できるZoneは以下の6種類のみとする。

```text
LIBRARY
HAND
BATTLEFIELD
GRAVEYARD
EXILE
SIDEBOARD
```

これ以外のZoneは存在しない。

---

# 13. Zoneごとの位置情報

`position`はBATTLEFIELDに存在するカードのみが持つ。

### BATTLEFIELD

整数のグリッド座標として、

```text
x
y
```

を保持する。

### BATTLEFIELD以外

位置情報は保持しない。

概念上、

```text
BATTLEFIELD
  position = { x, y }

その他
  position = undefined / null
```

とする。

この不変条件をサーバー側でも保証する。

---

# 14. Battlefieldのグリッド

Battlefieldは自由配置ではなく、整数座標によるグリッド配置とする。

UI上でのピクセル単位の位置は、グリッド座標からクライアント側で算出する。

グリッドの1マスは、通常状態（UNTAPPED）のカードの長辺を基準とした正方形とする。

カードがTAPPEDになった場合でも、グリッド自体のサイズ・向きは変更しない。

---

# 15. Battlefieldへのカード配置

カードをBATTLEFIELDへ移動する場合、必ず新しい`x / y`を指定する。

### ドラッグ＆ドロップ

カードをドラッグしてBattlefieldへ配置した場合、ドロップ位置に対応するグリッド座標を使用する。

### メニュー等からの移動

右クリックメニュー等からBattlefieldへ移動する場合は、あらかじめ定義された配置ルールによって自動的にグリッド座標を決定する。

具体的な自動配置ルールは未決。

---

# 16. Libraryの順序

Libraryは順序を持つ。

```text
index 0 = Libraryの一番上
```

とする。

したがって、index 0のカードが次にドローされるカードとなる。

配列の末尾がLibraryの一番下となる。

```text
[ 0, 1, 2, 3, ... , N ]

  ↑             ↑
  TOP         BOTTOM
```

---

# 17. 非Battlefield Zoneの順序

BATTLEFIELD以外のZoneには座標位置を持たせない。

ただし、カードの順序は必要に応じて保持する。

対象：

* LIBRARY
* HAND
* GRAVEYARD
* EXILE
* SIDEBOARD

具体的にどのデータ構造でZone内順序を管理するかは未決。

候補として、

```text
ZoneごとのCardInstanceId配列
```

または

```text
CardInstance側にorder情報を持たせる
```

等がある。

この点はDB設計時に確定する。

---

# 18. Card Face

カードの表裏状態は以下の2種類。

```text
FRONT
BACK
```

---

# 19. Card Visibility

カードの情報公開状態は以下の3種類。

```text
PUBLIC
CONTROLLER_ONLY
HIDDEN
```

### PUBLIC

すべてのプレイヤーがカード情報を確認できる。

### CONTROLLER_ONLY

現在のControllerのみがカード情報を確認できる。

Ownerではなく、あくまで現在のControllerを基準とする。

したがって、

```text
ownerId != controllerId
```

の場合でも、

```text
CONTROLLER_ONLY
```

なら現在のControllerのみがカード情報を閲覧できる。

### HIDDEN

誰もカード情報を確認できない。

`OWNER_ONLY`という状態は存在しない。

---

# 20. Card Tap State

カードのタップ状態は以下の2種類。

```text
UNTAPPED
TAPPED
```

`UNTAPPED`をデフォルト状態とする。

---

# 21. Counters

Card Instanceはカウンター数を保持する。

保持するカウンター情報は2種類のみ。

```text
plusOnePlusOne
other
```

### plusOnePlusOne

+1/+1カウンターの個数。

### other

+1/+1カウンター以外のすべてのカウンターを合計した個数。

個々のカウンターの種類・名称・詳細は保存しない。

---

# 22. Library View

プレイヤーがLibraryを確認するためのLibrary Viewを持つ。

1プレイヤーにつき、同時に1つだけLibrary Viewを保持できる。

既にLibrary Viewが存在する状態で別の枚数を確認する場合、

```text
現在のLibrary Viewを終了
↓
新しいLibrary Viewを作成
```

という扱いにする。

Library Viewはカードを別Zoneへ移動させる処理ではない。

カードはLibraryに存在したままである。

Library Viewの具体的なデータ構造および閲覧可能範囲の仕様は未決。

---

# 23. Zone移動

Card InstanceをZone間で移動させる場合、基本的に以下の処理を行う。

1. `zone`を移動先に変更
2. `tapState = UNTAPPED`
3. `face = FRONT`
4. 移動先Zoneに応じて`visibility`を設定
5. 移動先がBATTLEFIELDなら新しい`position`を設定
6. 移動先Zoneに応じてCountersを維持またはリセット

---

# 24. Zone移動時のTap State

Zone移動では、移動元・移動先に関係なく必ず、

```text
tapState = UNTAPPED
```

とする。

したがって、例えば、

```text
BATTLEFIELD(TAPPED)
    ↓
GRAVEYARD
```

の場合、

```text
GRAVEYARD(UNTAPPED)
```

となる。

---

# 25. Zone移動時のFace

Zone移動では、移動元・移動先に関係なく必ず、

```text
face = FRONT
```

とする。

例えば、

```text
BATTLEFIELD(BACK)
    ↓
HAND
```

の場合、

```text
HAND(FRONT)
```

となる。

---

# 26. Zone移動時のVisibility

通常のZone移動では、移動先Zoneに応じてvisibilityを自動設定する。

| 移動先         | デフォルトVisibility |
| ----------- | --------------- |
| BATTLEFIELD | PUBLIC          |
| GRAVEYARD   | PUBLIC          |
| EXILE       | PUBLIC          |
| HAND        | CONTROLLER_ONLY |
| SIDEBOARD   | CONTROLLER_ONLY |
| LIBRARY     | HIDDEN          |

ただし、これらは絶対的な制約ではない。

特殊なカード移動アクションによって、デフォルトとは異なるVisibilityを明示的に指定できる。

例：

```text
CONTROLLER_ONLY
    ↓
BATTLEFIELD
```

または、

```text
HIDDEN
    ↓
EXILE
```

などを許容する。

したがって、

「Zone移動処理のデフォルトvisibility」

と

「明示的に指定されたvisibility」

を区別できる設計とする。

具体的なAPI / Action設計は未決。

---

# 27. Zone移動時のCounters

移動先によってCountersの扱いを変更する。

### 維持するZone

```text
BATTLEFIELD
EXILE
```

移動直前のカウンター数をそのまま維持する。

### リセットするZone

```text
LIBRARY
HAND
GRAVEYARD
SIDEBOARD
```

すべてのカウンターを0にする。

例えば、

```text
BATTLEFIELD
plusOnePlusOne = 3
other = 2
```

からEXILEへ移動した場合、

```text
EXILE
plusOnePlusOne = 3
other = 2
```

となる。

一方、GRAVEYARDへ移動した場合、

```text
GRAVEYARD
plusOnePlusOne = 0
other = 0
```

となる。

---

# 28. Zone移動時のposition

### BATTLEFIELDへ移動

新しい`x / y`を必ず設定する。

移動元のpositionをそのまま引き継ぐ仕様にはしない。

### BATTLEFIELDから移動

BATTLEFIELD以外へ移動する場合、positionを削除する。

### その他Zone間の移動

positionは存在しない。

---

# 29. Zone移動処理の基本仕様まとめ

通常のZone移動を以下のように定義する。

```text
moveCard(card, destinationZone)

    zone
      ↓
    destinationZone

    tapState
      ↓
    UNTAPPED

    face
      ↓
    FRONT

    visibility
      ↓
    destinationZoneのデフォルト値

    position
      ↓
    BATTLEFIELDなら新規x/y
    それ以外ならなし

    counters
      ↓
    BATTLEFIELD / EXILE
        → 維持

    LIBRARY / HAND / GRAVEYARD / SIDEBOARD
        → 0にリセット
```

ただし、Visibilityについては特殊アクションによる明示的な上書きを許容する。

---

# 30. Match開始時のDeck

Match開始時には、プレイヤーが使用するDeckをコピーしてMatch用のDeck Snapshotを作成する。

Match開始後にユーザーが保存済みDeckを変更しても、現在進行中のMatchには影響しない。

概念上、

```text
保存済みDeck
    ↓ Match開始
Match Deck Snapshot
    ↓
Game
```

という関係とする。

Deckの具体的なデータ構造は未決。

---

# 31. GameState

GameStateは1ゲーム全体の現在状態を保持する。

現時点では概念的に以下を含む。

```text
gameId
matchId
status
turnNumber
activePlayerId
phase
step
players
cards
libraryViews
```

### cards

Game中に存在するCard Instance群。

実装上は、

```text
Record<CardInstanceId, CardInstance>
```

等の構造を候補とする。

### players

各PlayerのGame内状態。

具体的なPlayerStateのフィールドは未決。

### phase / step

ゲームの進行状態。

具体的な値・遷移ルールは未決。

---

# 32. ゲームサーバーの基本方針

ゲームサーバーは、プレイヤーの操作によってGameStateを変更する。

一方で、プレイヤーの勝敗についてはサーバーがゲームルールから自動判定しない。

また、カードのZone移動時におけるTap State、Face、Visibility、Countersについては、本仕様で定義された状態遷移ルールに従ってサーバー側で状態を更新する。

---

# 33. 現時点で未決の主な事項

以下は今後確定する必要がある。

## データモデル

* UserのDB管理項目の詳細
* Playerの詳細フィールド
* PlayerStateの詳細
* Card Masterの詳細メタデータ
* Deckのデータ構造
* Match Deck Snapshotのデータ構造
* Card Instance IDの生成・永続化方法
* Card InstanceのGame終了後の扱い

## Zone

* 非Battlefield Zoneのカード順序をどのデータ構造で保持するか
* 手札・墓地・追放・サイドボード等の並び替えルール
* Zone移動時に、移動先Zoneのどの位置へカードを挿入するか
* Libraryへのカード追加時の位置指定方法

## Battlefield

* メニュー等からBattlefieldへ移動する場合の自動配置ルール
* 同一グリッド座標へのカード配置を許可するか
* グリッドの原点・座標系
* Battlefieldのサイズ・範囲

## Card操作

* Owner変更
* Controller変更
* Face変更
* Tap / Untap
* Visibility変更
* Counter変更
* カードの複製・生成・削除
* カードを直接別Zoneへ移動する各種Action

## Library View

* Library Viewの具体的なデータ構造
* 閲覧枚数の扱い
* 閲覧中カードの公開範囲
* Library View中のカード操作可否

## Game進行

* Phase
* Step
* Turn開始・終了処理
* Active Player
* Turnの具体的な進行方法
* Game開始処理
* Game終了処理
* Match終了条件

## Room / Match

* Roomの詳細状態
* Matchの最大Game数
* Match終了条件
* Match履歴を保存するか
* Match終了後にどのデータをDBに残すか

## 通信

* WebSocketメッセージ形式
* Client → Server Action
* Server → Client Event
* GameStateの初期同期
* 差分更新方式
* 再接続時の状態同期
* エラー形式
* 権限チェック

---

# 34. 設計上の重要な不変条件

実装時には、以下をサーバー側で保証する。

### Card Instance

```text
BATTLEFIELD
    → position必須

BATTLEFIELD以外
    → positionなし
```

### Zone移動

```text
Zone移動後
    tapState = UNTAPPED
    face = FRONT
```

### Visibility

通常移動では移動先Zoneのデフォルト値を使用する。

ただし、明示的な特殊アクションによる上書きを許可する。

### Counters

```text
BATTLEFIELD / EXILE
    → 維持

その他
    → 0
```

### Library

```text
index 0 = TOP
array末尾 = BOTTOM
```

### Controller Only

```text
CONTROLLER_ONLY
    → ownerではなくcontrollerのみ閲覧可能
```

---

# 35. 現時点の設計状況

本書の内容は、現在までの確認事項を基にした**データモデル・ゲーム状態仕様の暫定確定版**とする。

今後は、未決事項を順番に確認した上で、

1. データモデル確定
2. TypeScript型定義
3. PostgreSQL / Drizzle DB設計
4. Game Action仕様
5. WebSocket通信仕様
6. Server側の状態管理
7. Client側の状態管理
8. API仕様
9. UI仕様

の順に詳細化する。
