# 06. ViewState（非公開の一時閲覧状態）

## 1. 目的

ライブラリ上部の閲覧や検索など、カードを一時的に見るだけで Canonical GameState を変更しない操作を扱う。閲覧操作を通常の Game Event と混同しない。

## 2. 基本原則

- ViewState は Canonical GameState の外にある一時状態。
- 1 Player は同時に 1 つの ViewState のみ持てる。
- 新しい ViewState を開始すると、同 Player の既存 ViewState を置き換える。
- ViewState は一人の viewer 専用。
- ViewState の開始・変更・終了通知は View Notification であり、Game Event / sequence を消費しない。
- ViewState が存在しても、実際のカード移動・並べ替えは Command で GameState を変更し、Game Event を発行する。
- Disconnect だけでは ViewState を終了しない。Game 終了では終了する。
- 独立した ViewState timeout は設けない。

## 3. ViewState のデータ

概念形式：

```ts
type ViewState = {
  viewId: string; // 全 Game を通して一意
  viewerPlayerId: string;
  viewType: "LIBRARY_TOP" | "LIBRARY_SEARCH" | "ZONE_VIEW";
  sourceZoneId: string;
  viewedCardIds: string[]; // 閲覧時点の順序
  selectedCardIds?: string[];
};
```

- `viewId` はサーバー生成 UUID 等で、全 Game で一意。
- `viewType` は `LIBRARY_TOP` / `LIBRARY_SEARCH` / `ZONE_VIEW` の汎用分類とし、個々のカード効果名を埋め込まない。
- `viewedCardIds` は閲覧した順序を保持する。
- GameState の Zone 配列は、Confirm されるまで変更しない。
- `selectedCardIds` は閲覧者だけの一時選択情報。
- `viewedCardIds`と`selectedCardIds`はサーバー内部状態であり、Viewer本人向けのprivate ViewState notification / syncにのみ含める。

## 4. 通知

ViewState 開始時：

- Viewer には実際の閲覧カード情報を送る。
- 両 Player に、閲覧者・種類・元 Zone・枚数などの公開情報を送る。
- 公開通知にカードの識別情報は含めない。
- 例：`viewerPlayerId`, `viewType`, `sourceZoneId`, `count`。
- `viewId` は通知で共有してよい。

ViewState 終了時：

- 例：`viewId`, `viewerPlayerId`, `reason`。
- `reason` は `CONFIRMED` / `CANCELLED` / `REPLACED` / `GAME_ENDED`。
- 終了通知にカード内容は含めない。
- GameState が変更された場合は Game Event を先に送り、その後 ViewState 終了通知を送る。

## 5. Command

ViewState 操作用の Command：

- `StartView`
- `SelectViewCard`
- `ReorderViewCards`
- `ConfirmView`
- `CancelView`

各 Command のpayloadを次のように定める。objectは未知fieldを拒否する。

| Command | payload | 意味 |
| --- | --- | --- |
| `StartView` | `{ sourceZoneId, viewType, count? }` | `viewType` は `LIBRARY_TOP` / `LIBRARY_SEARCH` / `ZONE_VIEW`。`LIBRARY_TOP` はLibrary Zoneと正の整数 `count` 必須（Zone内の枚数を超えるcountは拒否）。`LIBRARY_SEARCH` はLibrary Zone全体、`ZONE_VIEW` は閲覧権限のあるZone全体を対象とする。その他のcountは不可。閲覧対象のcardIdはクライアントから受け取らず、サーバーがZoneから決定する。 |
| `SelectViewCard` | `{ viewId, cardId, selected }` | `selected` は boolean。cardId は当該Viewerの有効なViewStateに含まれる必要がある。 |
| `ReorderViewCards` | `{ viewId, cardIds }` | `cardIds` は閲覧対象全件の新しい順序。現在の`viewedCardIds`の完全な順列でなければならず、重複・対象外ID・欠落を拒否する。 |
| `ConfirmView` | `{ viewId, moves? }` | `moves` は省略時空配列。各要素は `{ cardId, destinationZoneId, position?, insertIndex? }`。移動対象は同ViewStateで選択済みのカードに限る。移動しない閲覧カードは、確定済みViewStateの順序を保って元Zoneに残す。 |
| `CancelView` | `{ viewId }` | 対象ViewStateを破棄し、GameStateを変更しない。 |

`ConfirmView.moves` の各要素は `MoveCard` と同じ移動先に応じたposition / insertIndex条件に従う。カードの現在Zone、閲覧権限、選択状態、移動権限はサーバーが検証する。`StartView` は同一Playerの既存ViewStateを置き換える仕様を適用する。

### Zone別閲覧権限

- `LIBRARY_TOP` / `LIBRARY_SEARCH` は実行者自身のLibraryのみ対象とする。`LIBRARY_TOP.count` が現在枚数を超える要求は`VIEW_ACCESS_DENIED`。
- `ZONE_VIEW` はLibrary以外を対象とする。Battlefield / Graveyard / Exileは両Playerが閲覧でき、Hand / SideboardはOwnerのみ閲覧できる。相手のHand / SideboardはZone全体を閲覧対象にできない。
- `ZONE_VIEW`対象Zoneに`visibility`によって識別できないカードが含まれる場合、そのカードIDはViewStateへ入れず、閲覧・選択・移動・並べ替え対象にしない。GameStateView上では匿名項目として枚数を保つ。

### Notification / Sync payload

- `ViewStateStarted`は両Playerへ送信し、`viewId`, `viewerPlayerId`, `viewType`, `sourceZoneId`, `count`のみ含める。
- `ViewStatePrivate`はViewer本人だけへ送り、公開項目に加えて`viewedCardIds`, `selectedCardIds`、識別可能なカード詳細を含める。
- Select / Reorder後はViewer本人にのみ更新済み`ViewStatePrivate`を通知する。
- `ViewStateEnded`は両Playerへ送り、`viewId`, `viewerPlayerId`, `reason`のみ含める。
- `ViewStateSync`は有効なViewStateごとに各Player向けに生成する。Viewer本人にはprivate内容、相手には公開summaryだけを含める。InitialStateの後に送る。
- 通知はGame Eventではなく、Game sequenceを消費しない。ConfirmがGameStateを変更した場合、Canonical Game Event / Player別Event Viewを先に処理し、その後`ViewStateEnded`を通知する。
- `ConfirmViewApplied`のCanonical payloadには、確定後のsource Zone全体の`sourceZoneCardIds`を含める。Player向けEvent Viewでは受信者に識別が許可されないcardIdを除去する。

- ViewState だけを変える Command は Game Event / sequence を消費しない。
- Confirm によって GameState を変更する場合は Game Event を発行する。
- Cancel は選択・並び替えを破棄し、GameState は変更しない。
- ReorderViewCards は ViewState 内の順序だけを変更する。
- 実際のカード移動・Zone 並び替えは Confirm 時にサーバーが適用する。

## 6. 秘密情報の検証

- Viewer が ViewState で取得した非公開 `cardId` は、その有効な ViewState の範囲内で Command に使用できる。
- サーバーは、指定 ID が Viewer の有効な ViewState に含まれること、対象 Zone に存在すること、操作が許可されていることを検証する。
- ViewState開始後にsource Zoneのカード構成または順序が変わった場合、そのViewStateはstaleであり、Confirmは`VIEW_STALE`として失敗する。失敗時はGameState / sequence / ViewStateを変更しない。
- Confirmは一意な選択済みカードだけを移動できる。移動・権限条件の検証は通常の`MoveCard`操作を再利用する。移動しなかった閲覧カードはViewStateの順序に従い、source Zone内で閲覧対象外カードの相対順序を維持する。
- ViewState 終了後、そこで得た情報を使い続ける権限はない。
- ViewState 終了時にクライアントは private viewed info を破棄する。
- 他 Player は非公開カードの ID や内容を受け取らない。

## 7. 再接続

- InitialState には ViewState を含めない。
- InitialState の後に、有効な ViewState があれば `ViewStateSync` を送る。
- Viewer には実カード情報、相手には公開情報のみを送る。
- Reconnect は ViewState を新規作成せず、既存状態を同期する。
