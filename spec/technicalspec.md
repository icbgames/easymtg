# EasyMTG 技術仕様書

## 1. 概要

### 1.1 目的

本仕様書は、ブラウザ上で動作する2人対戦型カードゲーム「EasyMTG」の技術仕様を定義する。

本システムは、Magic: The Gathering等のカードゲームを想定した、汎用的なテーブルトップ型ゲームシステムである。

ゲームルールを完全にシステムへ実装するのではなく、プレイヤーがカードを操作しながらゲームを進行できることを主目的とする。

### 1.2 基本方針

* ブラウザベースのWebUI
* 中央サーバー方式
* サーバーをゲーム状態の正とする
* クライアントはゲーム状態を直接変更しない
* ゲームルールによる勝敗判定は原則としてサーバーでは行わない
* カードの配置・移動・タップ・表裏変更・カウンター変更等をプレイヤーが手動で操作する
* 将来的な多人数対戦は想定せず、常に2人対戦とする

---

# 2. システム構成

## 2.1 想定技術

現時点での基本方針：

* Node.js
* TypeScript
* Webブラウザ
* WebSocketによるリアルタイム通信
* 中央サーバーによるゲーム状態管理

詳細なフレームワーク・DB・WebSocketライブラリ等は未決定。

---

# 3. ゲーム階層

ゲーム構造は以下とする。

```text
Room
└─ Match
   ├─ Game 1
   ├─ Game 2
   ├─ Game 3
   ├─ Game 4
   └─ Game 5
```

### 3.1 Room

プレイヤーが対戦するための部屋。

* Room ownerが存在する
* Room ownerが最初にターンを開始する
* RoomにはMatchが紐づく
* Match終了後、Roomは自動削除される
* Room作成時に使用するDeckを確定する
* Match/Game開始後のDeck編集によって、進行中のゲームのDeck内容は変化しない

### 3.2 Match

1回の対戦全体を表す。

* 1つのRoomに対応する
* 最大5 Gameから構成される
* あるプレイヤーが最初の3 Gameを勝利していても、Game 4、Game 5を実施する
* システムはMatchの勝敗を管理しない

### 3.3 Game

実際の1ゲームを表す。

* Gameは必ずMatchに所属する
* standaloneなGameは存在しない
* `gameId` はサーバーが生成する一意なID
* Game終了後もGameStateを保持可能
* 通常終了はプレイヤーによるConcedeのみ
* それ以外の理由による中断・継続不能は `ABANDONED`

---

# 4. GameState

## 4.1 概要

`GameState` は1つのGameにおける現在の完全なゲーム状態を表す。

* サーバーがCanonical Stateを保持する
* クライアントはGameStateを直接変更できない
* 永続化・復元可能な状態として設計する
* クライアント専用のUI状態は含めない

---

## 4.2 GameState構造

概念上、以下の構造とする。

```text
GameState
├─ gameId
├─ matchId
├─ status
├─ turnNumber
├─ activePlayerId
├─ phase
├─ step
├─ players
├─ cards
└─ zones
```

具体的なJSON形式はWebSocket仕様策定時に確定する。

---

## 4.3 gameId

* Gameを一意に識別するID
* サーバーが生成する
* 全Gameで一意

---

## 4.4 matchId

* Gameが所属するMatchを識別する
* 必須
* Gameは必ず1つのMatchに所属する

---

## 4.5 status

Gameの状態を表す。

```text
WAITING
PLAYING
FINISHED
ABANDONED
```

### WAITING

ゲーム開始条件を満たすまでの待機状態。

### PLAYING

ゲーム進行中。

### FINISHED

プレイヤーが明示的にConcedeしたことによる正常終了。

システムは以下を理由として `FINISHED` にしない。

* Lifeが0以下
* Libraryが空
* 特定の勝利条件を満たした
* その他のゲームルール上の勝敗条件

### ABANDONED

Concede以外の理由でゲームが中断され、継続不能となった状態。

具体的な判定条件は未決定。

---

# 5. ターン管理

## 5.1 turnNumber

整数値。

* 初期値は `1`
* ターンが変わるたびに1増加
* プレイヤーが変わってもリセットしない

例：

```text
Player A: turn 1
Player B: turn 2
Player A: turn 3
Player B: turn 4
```

---

## 5.2 activePlayerId

現在のターンプレイヤーを表す。

```text
activePlayerId = playerId
```

これは「現在操作できるプレイヤー」を意味しない。

各Actionごとに実行権限を個別に判定する。

---

## 5.3 startingPlayerId

GameStateには保持しない。

Room ownerが最初のターンを開始する仕様であり、別途保持する必要がないため。

---

# 6. Phase / Step

## 6.1 Phase

```text
BEGINNING
PRECOMBAT_MAIN
COMBAT
POSTCOMBAT_MAIN
ENDING
```

## 6.2 Step

### BEGINNING

```text
UNTAP
UPKEEP
DRAW
```

### PRECOMBAT_MAIN

```text
null
```

### COMBAT

```text
BEGIN_COMBAT
DECLARE_ATTACKERS
DECLARE_BLOCKERS
COMBAT_DAMAGE
END_COMBAT
```

### POSTCOMBAT_MAIN

```text
null
```

### ENDING

```text
END
CLEANUP
```

---

## 6.3 ターン開始時

Game開始時：

```text
turnNumber = 1
activePlayerId = Room owner
phase = BEGINNING
step = UNTAP
```

---

## 6.4 ターン進行

サーバーによる自動進行は行わない。

プレイヤーが明示的にActionを実行して進行させる。

ゲームルール上の通常の進行順をサーバーは強制しない。

ただし、PhaseとStepの組み合わせとして不正な状態になることは防止する。

---

# 7. PlayerState

## 7.1 構造

```text
PlayerState
├─ playerId
└─ life
```

### playerId

ゲーム内プレイヤーを識別する。

### life

プレイヤーのLife。

* 初期値の具体的な設定はゲーム仕様側で定義
* 0以下になってもGameを自動終了しない
* 負の値を許容する

Zoneの枚数等はPlayerStateに重複して保持しない。

---

# 8. CardInstance

CardInstanceは、ゲーム中に存在する個々のカードを表す。

```text
CardInstance
├─ cardId
├─ cardDefinitionId
├─ ownerPlayerId
├─ controllerPlayerId
├─ tapped
├─ faceDown
├─ position
├─ counters
└─ visibility
```

---

## 8.1 cardId

ゲーム内の個々のカードを一意に識別する。

* サーバー生成
* 同じカード定義でも別カードなら別ID
* Zone移動しても変化しない
* Actionでカードを指定する際に使用する

---

## 8.2 cardDefinitionId

カード定義を参照するID。

カード名・画像・カードテキスト等のカード固有情報はGameStateに直接埋め込まず、外部のカード定義で管理する。

---

## 8.3 ownerPlayerId

カードの所有者。

* ゲーム中に変更しない
* Controllerとは独立する

---

## 8.4 controllerPlayerId

現在のコントローラー。

* Ownerと異なる場合がある
* カード操作権限の基本判定に使用する

---

## 8.5 zoneId

CardInstanceには保持しない。

カードの所属ZoneはZone側の `cardIds` を正とする。

---

## 8.6 tapped

```text
true  = タップ
false = アンタップ
```

Zone移動時には必ず `false` にリセットする。

---

## 8.7 faceDown

```text
true  = 裏向き
false = 表向き
```

カード定義に専用の裏面が存在しない場合でも `faceDown = true` を設定可能。

表示方法はUI側で決定し、汎用的なカード裏面等を表示できる。

`faceDown` と `visibility` は独立した状態である。

---

## 8.8 position

```text
position:
{
  x: integer,
  y: integer
}
```

または

```text
position = null
```

* Battlefieldのみ座標を持つ
* Battlefield以外では `null`
* Battlefieldへ移動する際には新しい座標を必須とする
* Drag & Dropの場合はドロップ位置を使用
* クライアント側でピクセル座標へ変換する

---

## 8.9 counters

```text
counters:
{
  plusOnePlusOne: integer,
  other: integer
}
```

カウンターは2種類のみ管理する。

```text
PLUS_ONE_PLUS_ONE
OTHER
```

`OTHER` は個別の種類を区別しない。

両方とも0未満にはならない。

---

## 8.10 visibility

```text
PUBLIC
CONTROLLER_ONLY
HIDDEN
```

### PUBLIC

両プレイヤーがカード情報を閲覧可能。

### CONTROLLER_ONLY

現在のControllerのみカード情報を閲覧可能。

### HIDDEN

誰もカード情報を閲覧できない。

Visibility判定はOwnerではなくControllerを基準とする。

---

# 9. Zone

## 9.1 Zone数

1 Gameにつき11 Zone。

```text
Player A
├─ Library
├─ Hand
├─ Graveyard
├─ Exile
└─ Sideboard

Battlefield

Player B
├─ Library
├─ Hand
├─ Graveyard
├─ Exile
└─ Sideboard
```

Battlefieldのみ共有Zone。

---

## 9.2 Zone構造

```text
Zone
├─ zoneId
├─ type
├─ ownerPlayerId
└─ cardIds[]
```

### zoneId

サーバー生成の一意ID。

Zoneの種類やOwnerをID文字列から推測しない。

### type

```text
LIBRARY
HAND
BATTLEFIELD
GRAVEYARD
EXILE
SIDEBOARD
```

### ownerPlayerId

* プレイヤーZone：対応するplayerId
* Battlefield：`null`

### cardIds

Zoneに所属するCardInstanceのID一覧。

Zone側の `cardIds` をカードの所属・順序の正とする。

---

# 10. Zoneの順序

Battlefield以外のZoneでは `cardIds[]` の順序に意味がある。

```text
index 0 = Zoneの先頭
last index = Zoneの末尾
```

Libraryについても同様。

```text
cardIds[0] = 次に引くカード
```

Battlefieldでは `cardIds[]` の順序に意味はない。

---

# 11. Zone移動時の状態リセット

実際にZoneが変化した場合、以下を適用する。

### 常にリセット

```text
tapped = false
faceDown = false
```

### Visibility

移動先Zoneのデフォルト値にする。

| Zone        | Default Visibility |
| ----------- | ------------------ |
| Battlefield | PUBLIC             |
| Graveyard   | PUBLIC             |
| Exile       | PUBLIC             |
| Hand        | CONTROLLER_ONLY    |
| Sideboard   | CONTROLLER_ONLY    |
| Library     | HIDDEN             |

特殊な操作による上書きについてはAction仕様で定義する。

### Position

* Battlefield：新しい `x/y` を設定
* その他：`null`

### Counters

移動先によって処理が異なる。

| 移動先         | Counters |
| ----------- | -------- |
| Battlefield | 維持       |
| Exile       | 維持       |
| Library     | 0にリセット   |
| Hand        | 0にリセット   |
| Graveyard   | 0にリセット   |
| Sideboard   | 0にリセット   |

例えば、

```text
Battlefield → Exile
```

ではCounterを維持する。

その後、

```text
Exile → Graveyard
```

とした場合はCounterを0にする。

---

# 12. 同一Zone内の並び替え

同じNon-Battlefield Zone内でカードの順序を変更できる。

使用Action：

```text
ReorderCard
├─ cardId
├─ zoneId
└─ insertIndex
```

* Battlefieldでは使用不可
* 指定Zoneにカードが存在する必要がある
* `insertIndex` は必須
* `0` = 先頭
* `cardIds.length` = 末尾
* 任意の位置へ移動可能
* Zone移動ではないためCardInstanceの状態をリセットしない

---

# 13. Action

## 13.1 基本原則

基本的に、

> 1 Action = 1種類のState Change

とする。

ただし、PhaseとStepは一体となった「Turn Position」として扱うため、`ChangeTurnPosition` のみPhaseとStepの2項目を同時変更する。

複数の独立した状態変更が必要な場合は、複数Actionを順番に実行する。

---

# 14. MoveCard

```text
MoveCard
├─ cardId
├─ destinationZoneId
├─ insertIndex?
└─ position?
   ├─ x
   └─ y
```

## 権限

基本的には対象カードの現在のController。

## 移動先がNon-Battlefieldの場合

```text
position = 指定不可
insertIndex = 任意
```

`insertIndex` を省略した場合は `0`（先頭）。

## 移動先がBattlefieldの場合

```text
position = 必須
insertIndex = 指定不可
```

## その他

* 現在Zoneはクライアントから指定しない
* サーバーがCardInstanceとZoneの状態から特定する
* 任意の現在Zoneから任意のZoneへの移動を基本的に許可
* 実際のゲームルール上の合法性はサーバーでは判定しない
* 同一Zone内の並び替えには `ReorderCard` を使用する

Zone移動時の状態リセットを適用する。

---

# 15. ReorderCard

```text
ReorderCard
├─ cardId
├─ zoneId
└─ insertIndex
```

* Non-Battlefieldのみ
* 基本権限：現在のController
* 任意位置への並び替え
* Zone移動ではない
* 状態リセットなし

---

# 16. TapCard / UntapCard

```text
TapCard
└─ cardId

UntapCard
└─ cardId
```

* `TapCard`：`tapped = true`
* `UntapCard`：`tapped = false`
* 既に目的状態でもエラーとしない
* 基本権限：現在のController
* Zone移動ではない

---

# 17. TurnFaceDown / TurnFaceUp

```text
TurnFaceDown
└─ cardId

TurnFaceUp
└─ cardId
```

* `TurnFaceDown`：`faceDown = true`
* `TurnFaceUp`：`faceDown = false`
* 専用の裏面が存在しないカードでも使用可能
* 既に目的状態でもエラーとしない
* Visibilityとは独立
* 基本権限：現在のController

---

# 18. AddCounter / RemoveCounter

```text
AddCounter
├─ cardId
├─ counterType
└─ amount

RemoveCounter
├─ cardId
├─ counterType
└─ amount
```

### counterType

```text
PLUS_ONE_PLUS_ONE
OTHER
```

### amount

正の整数。

### AddCounter

指定数量を加算。

### RemoveCounter

指定数量を減算。

現在値を超える数量を削除しようとした場合は拒否する。

Counterの意味そのものはシステムでは解釈しない。

基本権限：現在のController。

---

# 19. ChangeController

```text
ChangeController
├─ cardId
└─ controllerPlayerId
```

* `controllerPlayerId` はゲーム内のプレイヤー
* Ownerは変更しない
* Controllerのみ変更する
* 基本権限：現在のController
* ゲームルール上、Control Changeが合法かどうかは判定しない
* Zone移動ではない
* その他のCardInstance状態を変更しない

---

# 20. ChangeVisibility

```text
ChangeVisibility
├─ cardId
└─ visibility
```

指定可能な値：

```text
PUBLIC
CONTROLLER_ONLY
HIDDEN
```

* 基本権限：現在のController
* 同じVisibilityへの変更も許可
* Zone移動ではない
* `faceDown`とは独立
* ゲームルール上の合法性は判定しない

---

# 21. MoveCardPosition

```text
MoveCardPosition
├─ cardId
└─ position
   ├─ x
   └─ y
```

* Battlefield上のカードのみ
* `x/y` は整数
* 基本権限：現在のController
* Positionのみ変更
* Zone移動ではない
* その他の状態を変更しない
* 座標のゲームルール上の妥当性はサーバーでは判定しない

---

# 22. ChangeLife

```text
ChangeLife
├─ playerId
└─ amount
```

* `amount > 0`：Life増加
* `amount < 0`：Life減少
* Lifeは負の値になってもよい
* Life 0によるGame終了は行わない
* **自分自身のLifeのみ変更可能**
* `executingPlayerId == playerId` が必須

`amount = 0` の扱いは未決定。

---

# 23. ShuffleZone

```text
ShuffleZone
└─ zoneId
```

* Battlefieldでは使用不可
* Zone全体の `cardIds[]` をランダムに並び替える
* CardInstance自体の状態は変更しない
* 基本権限：

  * `Zone.ownerPlayerId == executingPlayerId`
* Battlefieldのように `ownerPlayerId = null` のZoneには使用不可

主な用途はLibraryのシャッフル。

---

# 24. ChangeTurnPosition

```text
ChangeTurnPosition
├─ phase
└─ step
```

* PhaseとStepを同時に変更
* Phaseは必須
* Stepは、そのPhaseがStepを持つ場合は必須
* Main Phaseでは `step = null`
* Phase/Stepの不正な組み合わせは拒否
* 通常のゲームルール上の進行順は強制しない
* Active Playerは任意の有効なTurn Positionへ移動可能
* サーバーによる自動進行は行わない
* 基本権限：Active Player

---

# 25. EndTurn

```text
EndTurn
└─ no args
```

基本権限：Active Player。

サーバーが一つのActionとして以下を変更する。

```text
turnNumber += 1
activePlayerId = other player
phase = BEGINNING
step = UNTAP
```

以下は自動実行しない。

* Untap
* Upkeep
* Draw
* その他のゲームルール処理
* 勝敗判定

---

# 26. Concede

```text
Concede
└─ no args
```

実行したプレイヤー自身が投了する。

成功時：

```text
status = FINISHED
```

GameStateには以下を保持しない。

```text
winnerPlayerId
loserPlayerId
concedingPlayerId
```

Concede後は通常のGame Actionを実行できない。

---

# 27. StartGame

Game開始処理。

```text
StartGame
└─ no args
```

通常のPlayer Actionではなく**システムAction**。

`WAITING` のGameに対して実行する。

実行時：

```text
status = PLAYING
turnNumber = 1
activePlayerId = Room owner
phase = BEGINNING
step = UNTAP
```

さらに、

* 各プレイヤーのLibraryをシャッフル
* 各プレイヤーが7枚引く

を行う。

StartGame後、通常のGame Actionが実行可能になる。

### 未決定

* StartGame内部での初期7枚のDraw処理を、内部的な`DrawCard`として扱うか、StartGameが直接Stateを変更するか
* WAITINGからPLAYINGへ移行できる具体的条件

これらは後のCommand/EventおよびRoom/Match/Game lifecycle設計で決定する。

---

# 28. DrawCard

```text
DrawCard
├─ playerId
└─ amount
```

指定プレイヤーがLibraryからカードを引く。

* `amount` は正の整数
* Libraryの `cardIds[0]` から順番に取り出す
* Handへ追加する
* 引いたカードは通常のZone移動時リセットを適用する
* Libraryの順序は維持され、先頭から削除する
* Handへの追加位置は現時点では末尾とする

### 未決定

Libraryのカード枚数が不足している場合の処理。

また、誰が他プレイヤーを対象としたDrawCardを実行できるかについて、詳細な例外権限は未決定。

---

# 29. Mulligan

```text
Mulligan
└─ no args
```

実行プレイヤー自身のHandを対象とする。

処理：

1. Handの全カードを自身のLibraryへ戻す
2. Libraryをシャッフルする
3. Libraryから7枚引く

Zone移動に伴う通常の状態リセットを適用する。

他プレイヤーのカードには影響しない。

### 未決定

* Libraryが7枚未満の場合の処理
* Mulliganを実行できるタイミングをサーバーがどこまで検証するか
* Mulligan回数に応じた手札枚数変更など、詳細なMulliganルール

---

# 30. Actionの権限

基本的な権限はActionごとに定義する。

現在の基本権限：

| Action             | 基本権限          |
| ------------------ | ------------- |
| MoveCard           | 現在のController |
| ReorderCard        | 現在のController |
| TapCard            | 現在のController |
| UntapCard          | 現在のController |
| TurnFaceDown       | 現在のController |
| TurnFaceUp         | 現在のController |
| AddCounter         | 現在のController |
| RemoveCounter      | 現在のController |
| ChangeController   | 現在のController |
| ChangeVisibility   | 現在のController |
| MoveCardPosition   | 現在のController |
| ChangeLife         | 対象Player自身    |
| ShuffleZone        | ZoneのOwner    |
| ChangeTurnPosition | Active Player |
| EndTurn            | Active Player |
| Concede            | 実行Player自身    |
| StartGame          | システム          |
| DrawCard           | 詳細未決定         |
| Mulligan           | 実行Player自身    |

将来的に特定Actionについて例外的な権限を追加可能とする。

---

# 31. Actionとゲームルール

本システムは、テーブルトップ型の自由度を優先する。

そのため、サーバーは原則として以下を判定しない。

* カード効果の合法性
* MTG等のルール上の合法性
* 攻撃・ブロックの成立条件
* Life 0による敗北
* Library枯渇による敗北
* 特殊勝利条件
* Control Changeの合法性
* カードを特定のZoneへ移動できるかというゲームルール上の制約
* カードを特定の座標へ配置できるかというゲームルール上の制約

ただし、システム構造を壊す不正なStateやActionはサーバー側で拒否する。

例：

* 存在しないcardId
* 存在しないzoneId
* 不正なPhase/Step組み合わせ
* BattlefieldでないカードへのMoveCardPosition
* BattlefieldへのMoveCardでpositionが未指定
* Non-BattlefieldへのMoveCardでpositionを指定
* Counterが負になるRemoveCounter
* 存在しないPlayerへのController変更

---

# 32. Read / View操作

カードを見る、Libraryの上から一定枚数を確認する等の操作は、カードのZone移動を伴わない場合、State Change Actionとは別の概念として扱う。

したがって、

> Action = Stateを変更する操作

とし、

> View / Read = Stateを変更せず、許可された情報を取得する操作

として分離する方針とする。

### 未決定

具体的なView/Read API、および以下の詳細は今後決定する。

* Libraryの上からN枚を見る
* Handを見る
* Graveyardを見る
* Exileを見る
* Sideboardを見る
* 相手のHidden Zoneについて枚数だけ取得する
* 閲覧中のカード情報をどの形式でクライアントへ送信するか

---

# 33. 現時点で未決定の主要事項

以下は今後決定する。

## Game Lifecycle

* Room作成からMatch開始までの詳細
* WAITING → PLAYINGの具体的条件
* Game終了後のMatch進行
* Match終了条件
* ABANDONEDとなる具体的条件
* Disconnect / Reconnectの扱い

## Command / Event

* Commandの形式
* Eventの形式
* ActionとCommandの対応
* State変更の通知方法
* Event履歴を保存するか
* Event Sourcingを採用するか

## WebSocket

* 接続確立
* 認証
* Client → Server Message形式
* Server → Client Message形式
* GameState同期
* 差分更新
* 再接続時のState同期

## Private Information

* Playerごとに異なるGameState View
* Hiddenカード情報のマスキング方法
* 相手のHand / Library / Sideboardの表示
* Libraryの閲覧API
* 一時的に公開されるカード情報の扱い

## Database

* 使用DB
* Room保存
* Match保存
* Game保存
* Deck保存
* GameState保存方式
* Event保存方式

## Session / Authentication

* Anonymous User IDの発行
* Cookie等への保存
* Browser変更時の扱い
* Session有効期限
* Reconnect
* 複数タブからの接続

## Deck

* Deckデータ構造
* Mainboard / Sideboardの永続化形式
* Deck編集API
* Save処理
* Deck Validation
* Room作成時のDeck Snapshot処理

## UI

* Battlefield表示
* カードドラッグ＆ドロップ
* Context Menu
* Zone表示
* Hidden Zone表示
* Counter操作UI
* Turn / Phase操作UI
* Gameログ
* Library View

---

# 34. 現時点のAction一覧

現在定義済みのActionは以下。

### Card

```text
MoveCard
ReorderCard
TapCard
UntapCard
TurnFaceDown
TurnFaceUp
AddCounter
RemoveCounter
ChangeController
ChangeVisibility
MoveCardPosition
```

### Player / Game

```text
ChangeLife
ShuffleZone
ChangeTurnPosition
EndTurn
Concede
DrawCard
Mulligan
```

### System

```text
StartGame
```

---

# 35. 今後の仕様策定順

今後は以下の順序で詳細化する。

1. GameState / PlayerState / CardInstance
2. Zone内部仕様
3. Action
4. Command / Event
5. WebSocket
6. Private Information View
7. Room / Match / Game Lifecycle
8. Database
9. Authentication / Session / Reconnect
10. Library View / Read操作
11. UI

現時点では1～3の主要部分を策定済みであり、次にCommand / EventおよびRead/View境界の具体化へ進む。
