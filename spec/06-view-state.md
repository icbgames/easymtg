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
  viewType: "LIBRARY_TOP" | "LIBRARY_SEARCH" | "ZONE_VIEW" | string;
  sourceZoneId: string;
  viewedCardIds: string[]; // 閲覧時点の順序
  selectedCardIds?: string[];
};
```

- `viewId` はサーバー生成 UUID 等で、全 Game で一意。
- `viewType` は汎用分類であり、個々のカード効果名を埋め込まない。
- `viewedCardIds` は閲覧した順序を保持する。
- GameState の Zone 配列は、Confirm されるまで変更しない。
- `selectedCardIds` は閲覧者だけの一時選択情報。

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

- ViewState だけを変える Command は Game Event / sequence を消費しない。
- Confirm によって GameState を変更する場合は Game Event を発行する。
- Cancel は選択・並び替えを破棄し、GameState は変更しない。
- ReorderViewCards は ViewState 内の順序だけを変更する。
- 実際のカード移動・Zone 並び替えは Confirm 時にサーバーが適用する。

## 6. 秘密情報の検証

- Viewer が ViewState で取得した非公開 `cardId` は、その有効な ViewState の範囲内で Command に使用できる。
- サーバーは、指定 ID が Viewer の有効な ViewState に含まれること、対象 Zone に存在すること、操作が許可されていることを検証する。
- ViewState 終了後、そこで得た情報を使い続ける権限はない。
- ViewState 終了時にクライアントは private viewed info を破棄する。
- 他 Player は非公開カードの ID や内容を受け取らない。

## 7. 再接続

- InitialState には ViewState を含めない。
- InitialState の後に、有効な ViewState があれば `ViewStateSync` を送る。
- Viewer には実カード情報、相手には公開情報のみを送る。
- Reconnect は ViewState を新規作成せず、既存状態を同期する。
