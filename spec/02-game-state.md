# 02. GameState / CardInstance / Zone

## 1. Canonical GameState

- サーバーが完全な Canonical GameState を保持する。
- クライアントは直接変更しない。
- GameState は永続化・復元可能なモデルとする。
- UI 専用状態と一時的な閲覧状態 ViewState は含めない。
- クライアントへ送る際は Player 別の GameStateView に変換する。

概念上の構造：

```ts
type GameState = {
  gameId: string;
  matchId: string;
  status: "WAITING" | "PLAYING" | "FINISHED" | "ABANDONED";
  turnNumber: number;
  activePlayerId: string;
  phase: Phase;
  step: Step | null;
  players: PlayerState[];
  cards: Record<string, CardInstance>;
  zones: Zone[];
  sequence: number;
};
```

実装時の正確な型は `packages/shared` と `packages/game` の schema に集約する。

## 2. PlayerState

- `playerId`
- `life`

Life はプレイヤー自身が管理する。
- Life は負数を許容する。
- Life が 0 以下でも Game を自動終了しない。
- 他プレイヤーの Life は変更できない。
- Zone のカード数など、他の場所から導出できる値を重複保持しない。

## 3. CardInstance

概念上のフィールド：

- `cardId`: Game 内の個別カード ID。サーバー生成、Zone 移動後も不変。
- `cardDefinitionId`: カード定義 ID。
- `cardDefinitionVersion`: Game 開始時に解決した不変 Version 番号。
- `ownerPlayerId`: 所有者。Game 中に変更しない。
- `controllerPlayerId`: 現在のコントローラー。Owner と異なる場合がある。
- `tapped`: タップ状態。
- `faceDown`: 裏向き状態。
- `position`: Battlefield 上では整数 `x`,`y`、それ以外は `null`。
- `counters`: `plusOnePlusOne` と `other` の 2 種類。
- `visibility`: `PUBLIC` / `CONTROLLER_ONLY` / `HIDDEN`。

カード定義の内容は CardInstance に複製せず、`(cardDefinitionId, cardDefinitionVersion)` で解決する。

### Tap / Face / Visibility

- `tapped=true` はタップ、`false` はアンタップ。
- `faceDown=true` は裏向き。カードに専用の裏面がなくても設定可能。
- `faceDown` と `visibility` は独立。
- Visibility の基準は Owner ではなく Controller。
- `PUBLIC`: 両 Player がカード情報を閲覧可能。
- `CONTROLLER_ONLY`: Controller のみカード情報を閲覧可能。
- `HIDDEN`: カードの識別情報を誰にも公開しない。

### Position

- Battlefield のみ整数座標を持つ。
- Battlefield へ移動する場合は新しい座標が必須。
- Drag & Drop はドロップしたグリッド座標を送る。
- 画面上のピクセル座標への変換はクライアント側。
- 非 Battlefield では `position=null`。
- Battlefield のグリッドセルは、タップ時の横向きカードを扱えるよう、カードの長辺を基準にする。

### Counters

```ts
type Counters = {
  plusOnePlusOne: number;
  other: number;
};
```

- `PLUS_ONE_PLUS_ONE` と `OTHER` のみ。
- `OTHER` の種類は個別管理しない。
- どちらも 0 未満不可。
- `AddCounter` / `RemoveCounter` の `amount` は正の整数。
- Remove が現在値を超える場合は失敗。

## 4. Zone

1 Game につき 11 Zone：
- Player ごとに `LIBRARY`, `HAND`, `GRAVEYARD`, `EXILE`, `SIDEBOARD`
- 共有 `BATTLEFIELD`

```ts
type Zone = {
  zoneId: string;
  type: "LIBRARY" | "HAND" | "BATTLEFIELD" | "GRAVEYARD" | "EXILE" | "SIDEBOARD";
  ownerPlayerId: string | null; // Battlefield は null
  cardIds: string[];
};
```

- Zone ID から type / owner を推測しない。
- 所属と順序の正本は Zone の `cardIds`。
- CardInstance に `zoneId` を重複保持しない。
- Battlefield 以外は配列順序に意味がある。
- Library の `cardIds[0]` が次に引くカード。
- Battlefield の `cardIds` の順序に意味はない。

## 5. Zone の公開範囲

- Public Zones: Battlefield、各 Player の Graveyard、各 Player の Exile。
- Hidden Zones: 各 Player の Hand、Library、Sideboard。
- Hand / Sideboard は Owner がカード情報を見られる。他 Player は枚数だけを見られる。
- Library のカード情報は通常は非公開。
- Hidden Card は GameStateView に枚数分の項目として残すが、`cardId` と `cardDefinitionId` は公開しない。
- Hidden Card に仮想 ID を付けない。隠しカードを個別追跡できないようにする。
- Hidden Card の移動はカード ID ではなく、Zone、index、位置、枚数などの公開可能情報で表す。
- Hidden Card View では owner/controller、tapped、faceDown、position、counters などの公開可能なゲーム状態は表現できるが、カード識別情報は含めない。
- View では `visibility` 自体を送信しない。

## 6. Zone 移動時のリセット

実際に Zone が変化した場合：

- `tapped=false`
- `faceDown=false`
- `visibility` は移動先 Zone の既定値
- Battlefield なら新しい `position`、それ以外は `null`
- Counter は移動先によって扱いが異なる

| 移動先 | Counter |
|---|---|
| Battlefield | 維持 |
| Exile | 維持 |
| Library | 0 にする |
| Hand | 0 にする |
| Graveyard | 0 にする |
| Sideboard | 0 にする |

既定 Visibility：

| Zone | Visibility |
|---|---|
| Battlefield | `PUBLIC` |
| Graveyard | `PUBLIC` |
| Exile | `PUBLIC` |
| Hand | `CONTROLLER_ONLY` |
| Sideboard | `CONTROLLER_ONLY` |
| Library | `HIDDEN` |

## 7. Turn Position

- `turnNumber` は 1 から開始し、ターンごとに 1 増加。Player が変わってもリセットしない。
- `activePlayerId` はターンプレイヤーであり、全操作の権限を意味しない。
- Phase: `BEGINNING`, `PRECOMBAT_MAIN`, `COMBAT`, `POSTCOMBAT_MAIN`, `ENDING`
- Step:
  - BEGINNING: `UNTAP`, `UPKEEP`, `DRAW`
  - PRECOMBAT_MAIN: `null`
  - COMBAT: `BEGIN_COMBAT`, `DECLARE_ATTACKERS`, `DECLARE_BLOCKERS`, `COMBAT_DAMAGE`, `END_COMBAT`
  - POSTCOMBAT_MAIN: `null`
  - ENDING: `END`, `CLEANUP`
- サーバーは通常のゲーム進行順を強制しないが、不正な Phase / Step 組合せは拒否する。
- サーバーは Untap / Upkeep / Draw / 勝敗判定などを自動実行しない。
