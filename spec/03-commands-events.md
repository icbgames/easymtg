# 03. Command / Game Event

## 1. 原則

- Command は要求、Event は確定した変更の記録。
- クライアントは GameState を直接変更しない。
- 基本的に 1 Command は 1 種類の状態変更を要求する。`ChangeTurnPosition` は Phase と Step を一体として変更する。
- 複数操作は別々の Command として順に送る。バッチ全体を一括トランザクションにはしない。
- Game ごとに Command 処理を完全直列化する。ある時点で 1 つの Command だけが GameState を操作する。

## 2. Command 共通形式

概念形式：

```ts
type CommandEnvelope = {
  type: string;
  commandId: string; // クライアント生成の全体一意 ID
  payload?: unknown;
};
```

- `playerId` は Command から信用せず、接続 Session / User / Room の対応からサーバーが特定する。
- `commandId` は Game sequence とは別。
- `commandId` は Game をまたいでグローバルに一意。
- 同一 `commandId` の処理済み Command は再実行しない。以前の CommandResult を再送できる。
- 処理済み Command と CommandResult は Game 終了まで保持し、Game 終了後に破棄可能。
- 後続 Game では新しい `commandId` を使用する。

## 3. CommandResult

共通形式：

```ts
type CommandResult = {
  type: "CommandResult";
  commandId: string;
  success: boolean;
  errorCode?: string; // failure のみ
};
```

- 成功時は最小限の結果だけ返す。状態変更の詳細は Game Event で通知する。
- 失敗時は `success=false` と機械判定可能な `errorCode` を返す。
- HTTP API の `{ error: ... }` 形式とは別のプロトコル形式。
- 送信者には CommandResult を先に送り、その後 Game Event を送る。
- 相手には Game Event のみ送る。
- 失敗時は CommandResult のみで、Game Event を発行しない。

## 4. 処理順序・原子性

Command は次の順で処理する：

1. 受信
2. Envelope / payload の形式検証
3. Session から Player を特定
4. `commandId` 重複確認
5. Game / Room / Player / ViewState の状態と権限を検証
6. 現在の最新確定状態に対して処理を適用
7. 成功なら状態変更を確定
8. Game Event を生成
9. Game sequence を確定
10. 永続化
11. CommandResult と Event を配信

- 失敗した Command は状態を変更せず、sequence を消費しない。
- Event を確定した後の配信失敗は、確定した状態変更を取り消さない。
- Game ごとに直列処理する。
- B の結果を待たずに C が送信されても、サーバーは受信順に処理する。
- B が成功すれば C は B 後の状態を見る。B が失敗すれば C は B 前の状態を見る。
- 1 Command の失敗で後続 Command を停止しない。
- クライアントは未確定の結果を成功と仮定して状態変更を確定しない。

## 5. Game Event

GameState の確定変更を通知するイベント。

- `eventId`: 全 Game を通して一意。UUID 等のランダム ID。
- `gameId`: 必須。
- `sequence`: Game ごとに 1 から始まる連番。
- `type`: Event 種類。
- `payload`: Event 内容。Player ごとに秘匿情報をマスキングできる。

概念形式：

```ts
type GameEventView = {
  type: "GameEvent";
  eventId: string;
  gameId: string;
  sequence: number;
  eventType: string;
  payload: unknown;
};
```

- `sequence` は Command 番号ではなく、Canonical GameState 変更の確定順序。
- 1 Event が 1 sequence を消費する。
- 同じ Game Event の両 Player 向け View は同じ `eventId`, `gameId`, `sequence`, `eventType` を持つ。
- `payload` は Player ごとに異なってよい。
- 各 Player は欠番なく連続した Game sequence を受信する。
- 同一 Session で sequence の回帰を起こさない。
- Ping/Pong、Welcome、CommandResult、InitialState、View Notification、Lifecycle Event は Game sequence を消費しない。

## 6. Event 発行と配信

- Canonical Event を生成し、その後 Player ごとの Event View に変換する。
- Hidden Card の ID や定義 IDを、許可されていない Player に含めない。
- 状態変更・Event・sequence・永続化を確定してから配信する。
- 配信失敗は commit を取り消さない。
- Game Event 履歴は Game が PLAYING の間保持する。
- Game 終了後は Event 履歴を削除してよい。再接続時は Event 再生ではなく最新状態を送る。

## 7. 既定 Command 群

ゲーム操作の Command は以下を基本とする。実際の envelope / payload schema は `packages/shared` で定義する。

- `MoveCard`
- `ReorderCard`
- `TapCard`
- `UntapCard`
- `TurnFaceDown`
- `TurnFaceUp`
- `AddCounter`
- `RemoveCounter`
- `ChangeController`
- `ChangeVisibility`
- `MoveCardPosition`
- `ChangeLife`
- `ShuffleZone`
- `ChangeTurnPosition`
- `EndTurn`
- `Concede`

ViewState 用 Command は `06-view-state.md` を参照する。

### MoveCard

- 現在 Zone はクライアントから指定せず、サーバーが状態から特定する。
- 基本権限は現在 Controller。
- Non-Battlefield への移動は `position` を指定不可、`insertIndex` は任意。省略時 `0`。
- Battlefield への移動は `position{x,y}` 必須、`insertIndex` は指定不可。
- Zone 移動時のリセット規則を適用する。
- 基本的な任意 Zone 移動を許可し、ゲームルール上の合法性は判定しない。

### ReorderCard

- Non-Battlefield の同一 Zone 内で順序変更する。
- `insertIndex` 必須。`0` は先頭、配列長は末尾。
- Zone 移動ではないため状態リセットなし。

### Tap / Face / Visibility

- 既に指定状態でもエラーにしない。
- 基本権限は Controller。
- Visibility は `PUBLIC` / `CONTROLLER_ONLY` / `HIDDEN`。
- Face と Visibility は独立。

### Counter

- `counterType`: `PLUS_ONE_PLUS_ONE` / `OTHER`
- `amount`: 正の整数
- Remove 量が現在値を超える場合は拒否。

### ChangeController

- `controllerPlayerId` は Game 内の Player でなければならない。
- Owner は変更しない。
- 基本権限は現在 Controller。

### MoveCardPosition

- Battlefield 上のカードのみ。
- `x`,`y` は整数。
- 基本権限は現在 Controller。
- Position のみ変更する。

### ChangeLife

- `amount > 0` は増加、`amount < 0` は減少。
- 負数 Life を許容し、Life 0 で Game 終了しない。
- 自分自身の Life のみ変更可能。
- `amount=0` の扱いは未決定。

### ShuffleZone

- Battlefield 以外のみ。
- Zone owner が実行可能。
- `cardIds` をランダムに並べ替える。CardInstance の他状態は変更しない。

### ChangeTurnPosition / EndTurn

- ChangeTurnPosition は Phase と Step を一体で変更。不正組合せを拒否。
- Active Player が実行可能。通常の進行順は強制しない。
- EndTurn は turnNumber を 1 増やし、Active Player を相手にし、Phase/Step を BEGINNING/UNTAP にする。
- Untap、Upkeep、Draw、勝敗判定は自動実行しない。

### Concede

- 実行者自身が投了する。
- 成功すると Game は `FINISHED`。
- 勝者・敗者や Match の勝敗は記録しない。
