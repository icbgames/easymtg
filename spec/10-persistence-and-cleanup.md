# 10. 永続化・履歴・クリーンアップ

## 1. 永続化の基本

- PostgreSQL を永続データの正本とし、Drizzle ORMでschema / queryを管理する。プロセス内Map・cacheは性能目的の派生データに限り、再起動後に復元できない状態を正本にしない。
- PostgreSQLのJSONBへGameState、Game Event、ViewState、Deckの順序付きcard ID配列、DeckSnapshot、Card Definition `rulesData`を保存する。検索・参照整合性・一意性が必要な所有者、状態、ID、sequence、version等は通常の列または関連表とする。
- PostgreSQLのmigrationを `database/migrations` に順序付きで保存し、適用済みmigrationをmigration管理表で追跡する。Production起動時に暗黙のschema変更を行わず、アプリ起動前にmigrationを明示実行する。migrationは後方互換のexpand → code deploy → contractを基本とする。
- サーバー起動時に保存GameStateをZod schemaで検証する。不整合データを推測修復せず、そのGameを操作不能としてエラーを記録する。
- 採用技術は PostgreSQL + Drizzle ORM。SQL transaction / row lockが必要な箇所はDrizzle transaction APIとPostgreSQLの明示lockを利用する。

## 2. 論理テーブルと制約

以下は論理schemaであり、列名・Drizzle定義は実装に委ねる。ここにない監査履歴は保存しない。

| Table | 保存内容・主要制約 |
| --- | --- |
| `users` | 匿名User ID、表示名、作成日時。User IDは主キー。 |
| `sessions` | Session ID、User ID、作成・有効期限。User削除時はcascade。Session IDは主キー、User参照にindex。Cookie tokenの表現はSession仕様で定める。 |
| `decks` | Deck ID、Owner User ID、name、mainboard / sideboardの順序付きCard Definition ID配列、更新日時。Owner / Deck IDをindex。Deckは明示保存のみ。 |
| `card_definitions` | Card Definition ID、現在Version、ENABLED / DISABLED。Status / IDで検索できるindex。`(id,current_version)`はVersion表へのdeferred FKで存在を保証する。Card Definition IDは再利用せず、物理削除しない。 |
| `card_definition_versions` | `(card_definition_id, version)`を主キーとする不変Version本文、`rulesData`、作成日時。親Card Definitionを参照。 |
| `rooms` | Room ID、Owner Player ID、WAITING / IN_MATCH、optional Match ID、作成日時。 |
| `room_players` | Room ID、Player ID、User ID、選択Deck ID、参加順序。Player IDは一意。Active Room参加を表すUser IDは全Room横断で一意。Room作成時のOwnerと参加者の整合性および最大2名はRoom transactionで保証する。 |
| `matches` | Match ID、Room ID、ACTIVE / ENDED、currentGameNumber、optional activeGameId、作成日時。Room IDは一意。RoomとMatch間のoptional相互参照はdeferred FKでtransaction commit時に整合させる。 |
| `match_players` | Match ID、Room ID、Player ID、seat order。2席を一意にし、`(room_id, player_id)`でRoom参加者を参照する。 |
| `games` | Game ID、Match ID、1〜5のGame番号、WAITING / PLAYING / FINISHED / ABANDONED、現在sequence、両Playerが全Session切断になった時刻（nullable）。`(match_id, game_number)`とGame IDは一意。 |
| `game_states` | Game IDを主キー / FKとしCanonical GameState JSONBを1件保持。 |
| `deck_snapshots` | `(game_id, player_id)`ごとに当該Game開始時のDeckSnapshot JSONB。 |
| `game_events` | Canonical Event JSONB、Game ID、sequence、event ID、作成日時。`(game_id, sequence)`とevent IDを一意にする。 |
| `game_event_views` | `(event_id, recipient_player_id)`ごとに、Event commit時のGameStateから生成した秘匿masking済みpayloadを保存する。Event rowと同じtransactionで作成する。 |
| `game_card_definition_refs` | Active Gameが参照する`(game_id, card_definition_id, version)`。Card Definition VersionへのFKを設け、cleanup raceをDB制約でも防止する。 |
| `command_results` | 全体一意なcommandId、Game / Player、Command fingerprint、CommandResult JSONB、作成日時。commandIdを主キーとする。 |
| `view_states` | `(game_id, viewer_player_id)`ごとに最大1件のprivate ViewState JSONB。viewIdは一意。 |
| `admin_request_results` | `(admin_id, request_id)`を主キーとし、canonical request fingerprint、HTTP status、response body、作成日時を保持する。 |

`connectionState`は永続Room属性ではなく、Server processが管理する有効WebSocket Session集合から算出する。RoomStateSync / Game command認可ではPlayerの全Session接続状態を集約する。Process再起動で全socketは切断され、再接続が確立するまではDISCONNECTED。Session row自体は期限まで残す。

Room PlayerのDeck、Match、Game、Snapshot生成は`spec/05`のRoom lifecycleに従う。Roomには常に1〜2人のParticipantが所属し、OwnerはParticipantであること。MatchにはRoom参加者2名がseat順に所属し、GameはMatchに属することをFKで保証する。Room / Matchの相互参照とOwner / Participantの複合FKはdeferred FKまたはtransaction内の制約triggerでcommit時に検証する。複合FKや部分的な状態制約で表せない状態遷移は必ずtransaction内で検証する。Room status / `matchId`、Match / active Game、Game status / GameStateの重複表現もcommit時に整合させ、load時に検証する。

## 3. Transaction / 排他制御

### Game Command

各Commandを1 DB transactionで処理する。

1. commandId由来のPostgreSQL transaction-level advisory lockを取得し、`command_results`を確認する。同じfingerprintなら保存済み結果を返し、異なる内容なら`COMMAND_ID_CONFLICT`。
2. Game rowを`SELECT ... FOR UPDATE`相当でlockし、現在のGameState、status、sequenceを読む。
3. Session / Player / Room権限と接続状態、Game状態、payloadを検証する。
4. 成功なら新GameState、Canonical Event、各Player向けEvent View、sequence + 1、成功CommandResultを同一transactionで保存する。
5. 操作起因の失敗ならGameState・Event・sequenceを変更せず、失敗CommandResultだけを保存する。
6. commit完了後にのみCommandResult / EventをWebSocket配信queueへ渡す。

fingerprintは`gameId`, `actorPlayerId`, Command `type`, canonical JSON化したpayloadから生成する。Object key順は正規化し、Array順は保持する。commandId由来のtransaction-level advisory lockで、異なるGameに対する同一IDも処理前に直列化し、`command_results.command_id`のPKは最後の制約として重複を防ぐ。advisory lock keyのhash collisionは余分な直列化だけを起こし、誤った結果再利用は起こさない。DB transaction中断など処理結果が未確定のエラーはreceiptを保存せず、再送可能とする。Envelope不正で相関可能な`commandId`のないmessageはreceipt対象外。

ViewState単独CommandはViewStateと成功CommandResultを同一transactionに保存し、GameState・Game Event・sequenceは変更しない。`ConfirmView`がGameStateを変える場合は上記のGameState / Event commit単位に従い、確定ViewStateの終了も同じtransactionで保存する。

Game row lockを同一Gameの全Commandの直列化点とし、`(game_id, sequence)` unique制約で重複sequenceを防止する。`games.current_sequence`とJSONB中の`GameState.sequence`は常に一致させ、読込時にも検証する。複数Game・複数Roomを一度にlockする処理ではIDの昇順にlockし、deadlockを抑える。DB失敗・commit失敗の場合は一切配信せず、同じcommandIdの再送で結果を再取得できるようにする。配信失敗はcommitを巻き戻さず、Clientは再接続同期で回復する。

### Room / Match / Game lifecycle

- Deckの明示保存はOwner User IDを条件にUPSERT / 更新し、同じtransaction内でDeck本文全体を置換する。他User所有Deck IDの上書きを許可しない。Card使用可能性はRoom / Game開始時に改めて検証する。
- Room create / join、2人目入室に伴うMatch・Game 1作成、Deck Snapshot / Version解決 / GameState初期化 / Card Version参照登録は単一transactionとする。
- joinはRoom rowをlockする。Deckと参照するCard Definitionは共有lockし、Game作成中にAdmin更新・DISABLED化・cleanupが割り込まないようにする。
- 次Game開始はMatch、Room、対象Deck、Card Definitionを同一transactionで検証・lockして作成する。
- Game終了、Game 5によるMatch終了、Room削除はGame rowを起点に、Match / Roomの順でlockし、Game / Matchの状態更新とcleanup判断を同じtransactionで確定する。
- Player接続状態の遷移はSession集合の変更により算出する。最初の接続・最後の切断の遷移だけLifecycle Eventを発生させる。heartbeatごとにGame EventやDB rowを更新しない。
- PLAYING Gameの両PlayerがともにDISCONNECTEDになった遷移で`all_players_disconnected_at`を設定する。いずれかのPlayerにSessionが1つでも接続したらNULLへ戻す。30分猶予は両Playerが全Session切断の間だけ進む。
- Server起動時はWebSocket registryが空であることを確定してから全Sessionを切断扱いにする。Active Gameの切断時刻が未設定なら起動時刻を設定し、既に設定済みなら維持する。復旧処理とWebSocket accept開始の順序を固定し、猶予を失わない。
- Admin Card Definition Version / Status更新は対象Card Definition rowを`FOR UPDATE`相当でlockし、`expectedVersion`検証、Version append、Status変更を同一transactionにする。

変更transactionはPostgreSQLの`READ COMMITTED`を使用し、上記のrow lockとunique / FK制約を正しさの根拠とする。Reconnect Syncの複数row読取は`REPEATABLE READ READ ONLY` snapshot transactionを使用する。ロックなしread-modify-writeで排他を代用しない。

## 4. Event / ViewState 永続化と再接続

- GameがPLAYINGの間、Canonical Game EventとPlayer別Event Viewをsequence順に全件保持し、Event replayの連続範囲判定に使う。Event ViewはEvent commit時のGameStateと`spec/03`のmasking規則で生成し、配信・replay時に再計算しない。後の公開状態を根拠に過去の非公開情報を露出させない。
- Event、GameState、Game rowのsequenceはCommand transactionで一緒にcommitする。sequenceはGame単位で1から増加し、失敗Command / ViewState単独操作では増やさない。
- Game終了のtransactionで、そのGameのEvent history、`command_results`、ViewState、Active GameのCard Definition Version参照を削除する。GameStateとDeckSnapshotはMatch終了まで残す。
- ViewStateは`spec/06`に従ってpersistする。ViewStateのみを変えるCommandはGame sequenceを変えず、GameStateを変えるConfirmはEvent・sequence・ViewState結果を同一transactionで確定する。
- Lifecycle Eventは再送用の履歴をDBに保存しない。切断中の通知はRoom / Match / Game Syncを正とする。
- reconnect snapshot取得中の競合を防ぐため、対象Sessionの同期batch登録を同じRoom coordinator queueへ入れる。coordinator内で`REPEATABLE READ READ ONLY` transactionからRoom / Match / Game / sequence / GameStateを一貫して読み、RoomStateSyncからInitialState / 差分Event / ViewStateSyncまでをSession FIFO queueへ連続登録してから次のRoom状態変更・配信を許可する。これによりcommit前後のLifecycle EventやGame Eventがsnapshotを追い越さない。Event replayはDBのsequence境界を使い、重複・欠落を避ける。
- `Hello.lastGameId` と現在のActive Game IDが一致し、`lastSequence`より後の全Eventを保持している場合のみ差分送信する。それ以外は現在のGameStateViewをInitialStateとして送る。

## 5. Match / Game cleanup

- Game 1〜4の終了時、GameStateとDeckSnapshotはMatch終了まで保持する。Event history、ViewState、idempotency結果、Active Version参照はそのGameの終了transactionで破棄する。
- Game 5終了時はMatchをENDEDへ遷移させる処理とRoom cleanupを単一transactionにまとめ、そのtransaction内でRoom、Match、全Game、GameState、DeckSnapshot、Event history、ViewState、command result、Game Version参照を削除する。勝敗・Match履歴はcommit後に残さない。`MatchEnded` payloadは削除前に作り、commit後の配信に必要な値を処理結果に保持する。Lifecycle Event履歴にはしない。
- `ABANDONED`もGame終了として扱う。Match自体はGame 5まで継続し、通常の30分切断猶予だけではRoom / Matchを削除しない。
- `all_players_disconnected_at + 30 minutes`到達時にGame rowをlockし、両Playerが今も全Session切断でGameがPLAYINGなら、GameState / GameをABANDONEDへ更新する。再接続が先にcommitされていればabandonを行わない。
- Active RoomのOwner退出によるRoom削除、およびMatch終了によるcleanupはtransactional cascadeとし、User / Deck / Card Definition / Versionは削除しない。
- Cleanupは再実行可能で、既に削除済みの対象を安全に処理する。FK cascadeだけに依存せず、cleanup対象を明示し参照整合性を保つ。

## 6. Card Definition Version cleanup

- 最新Versionは常に保持する。
- 古いVersionは`game_card_definition_refs`から参照される間保持する。
- Game開始transactionは必要なVersionの参照行を追加してからcommitする。cleanupは対象Version rowをlockし、最新でないこと、参照行がないことを同一transaction内で再確認して削除する。
- Gameが終了したら当該Gameの参照を解除する。古いVersionは非同期cleanupで削除可能。固定retention periodは設けない。
- Card Definition自体は物理削除しない。手動Version削除APIは設けない。
- GameStateに保存するのはCard Definition IDと固定Version番号であり、定義本文をCardInstanceに複製しない。GameStateはMatch終了時に削除するため、Version本文を要するReplay / 永続履歴を提供しない。

## 7. Idempotency record retention

- 管理APIのrequestIdと結果は、同一管理者・同一IDの再送で同じHTTP status / bodyを返せるよう保存する。request fingerprint、結果記録、Card Definition更新は同一transactionで確定する。
- 管理API結果の保証期間は作成時点から30日。30日経過後にcleanup可能であり、それ以降の再送の冪等性は保証しない。Clientは内容を変える再試行に新しいrequestIdを使い、古いrequestIdを再利用しない。
- Game CommandのCommandResultは当該Gameが終了するまで保持し、Game終了時に削除する。commandIdはClientが全Game / 全Sessionを通じて再利用しない。Game終了後の再送結果は保証しない。
- cleanupは期限列indexを使い、少量batchで非同期実行する。処理中のrequestId / commandIdを削除せず、同一IDの同時requestはunique制約とtransactionで一度だけ実行する。

## 8. Backup / recovery

- PostgreSQLの定期backupおよびpoint-in-time recoveryを運用環境で有効にする。復旧時点以後にcommitされたCommandは失われる可能性があり、失われたcommitをClientが認識できない場合も再接続同期を行う。
- WebSocket配信済みかどうかをDBの正本にしない。commit済みGameState / Event historyが回復の根拠。同期後にClientが適用済みsequenceを送ることで重複Eventを避ける。
- backup保持期間、RPO / RTO、restore drillの頻度は運用環境のリリース前に決定する。
