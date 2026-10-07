# 01. ドメインモデル

## 1. 階層

```text
User
└─ Player（Room 参加時に対応付け）
   └─ Room
      └─ Match
         ├─ Game 1
         ├─ Game 2
         ├─ Game 3
         ├─ Game 4
         └─ Game 5
```

- User と Player は別概念。
- 1 User は同時に最大 1 つの Active Room に所属できる。
- 1 Room は最大 2 Player。
- Game は必ず 1 Match に所属する。
- Room は Match 終了時に削除する。

## 2. User / Player / Session

### User

- ログインアカウントは設けない。
- サーバーが匿名 User ID を発行する。
- User ID は Cookie 等のブラウザ保存領域で維持する。
- ブラウザ変更などで別 User として扱われることは許容する。
- User に保持する追加情報は表示名のみ。

### Player

- Room 内で User が担う参加者。
- Room owner と Game の操作権限は別概念。
- Game 内では `playerId` で識別する。
- Player の接続状態は Session の集約状態から求める。

### Session

- 1 User が複数 Session（複数タブ等）を持つことを許可する。
- 同一 User の Session は同じ Player / Active Room に対応する。
- Player は、少なくとも 1 Session が接続中なら `CONNECTED`、全 Session が切断中なら `DISCONNECTED`。
- Session ID は他プレイヤー向けの Lifecycle Event には含めない。

## 3. Room

Room の主な情報：

- `roomId`
- `ownerPlayerId`
- 参加 Player（最大 2 名）
- 各 Player の選択 Deck
- `matchId`（Match 作成後）
- Room 状態（具体的な enum は実装時に共有 schema で定義）

Room owner の責務：

- 2 人参加済み、Deck 有効、適切な状態などの条件を満たす場合に StartMatch / StartGame を要求できる。
- Game 中に owner が切断しても特別な勝敗処理は行わない。
- owner が Room を退出した場合、残った Player に owner を移譲する。
- owner は Game の勝敗や相手の操作を強制変更できない。

## 4. Match

- 1 Room に対応する。
- Game 1〜5 を順に実施する。
- システムは勝敗を集計・保存しない。
- Game 5 終了後に Match を終了し、Room を自動削除する。
- Match は現在の Game 番号と状態を保持する。
- Match にサーバー判定の勝敗情報を持たせない。

## 5. Game

- `gameId` はサーバー生成の一意 ID。
- `matchId` は必須。
- `status`：
  - `WAITING`
  - `PLAYING`
  - `FINISHED`
  - `ABANDONED`
- `FINISHED` は Player の Concede による終了。
- それ以外の継続不能な終了は `ABANDONED`。
- Life が 0 以下、Library が空、その他のルール上の条件を理由に自動終了しない。
- Game 内部の `turnNumber` は 1 から開始し、ターンごとに 1 増加する。
- `activePlayerId` は現在のターンプレイヤーを表し、必ずしもすべての操作が可能な Player を意味しない。
- Room owner が各 Game の開始ターンプレイヤーとなる。`startingPlayerId` を GameState に重複保持しない。

## 6. Deck

- Deck は User が作成・編集・保存する。
- 保存は明示的な Save 操作のみ。自動保存しない。
- Mainboard は上限なし、同一カードの枚数制限なし。保存時に 60 枚以上を必須とする。
- 編集途中で Mainboard が 60 枚未満でもよいが、その Deck で Room 作成・参加はできない。
- Sideboard は上限なし、同一カードの枚数制限なし。Mainboard + Sideboard の合計上限は設けない。
- 各 Game 開始時点で Mainboard が 60 枚以上でなければならない。
- Deck には Card Definition ID の配列を保存し、Card Definition Version は保存しない。
- Deck 編集中の検索・表示・ソートは Card Definition の最新 Version を使う。
- 保存済み Deck は Card Definition の更新によって自動変更しない。
- DISABLED カードを含む既存 Deck は表示・編集できるが、新規 Room / Game での使用検証には失敗する。自動削除しない。

## 7. Room / Game 開始時の Deck Snapshot

- Room は使用 Deck を参照する。
- Match / Game 開始時に Deck の内容を Snapshot 化し、以降の Deck 編集で進行中 Game の内容を変えない。
- Snapshot は構成情報のみを持つ：

```ts
type DeckSnapshot = {
  deckId: string;
  deckName: string;
  mainboard: string[];   // cardDefinitionId
  sideboard: string[];   // cardDefinitionId
};
```

- Snapshot 自体に Card Definition Version は含めない。
- Game 開始時、各 `cardDefinitionId` を最新の有効な Version に解決し、各 CardInstance に固定する。
- 1 件でも解決失敗（存在しない、DISABLED、取得不能等）があれば Game 開始全体を失敗させる。部分開始しない。
