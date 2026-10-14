# EasyMTG

ブラウザ上で 2 人対戦するカードゲームアプリです。ゲームの挙動は `spec/gamespec`、技術上の前提は `spec/README.md` から参照する文書を正とします。

## 必要な環境

- Node.js 24.15 以降（`.node-version` 参照）
- pnpm 11.19.0（ルートの `packageManager` で固定）

## セットアップ

```sh
pnpm install
```

PostgreSQLを起動し、ルートの`.env.example`を`.env`へコピーして接続先を設定します。`.env`はGit管理対象外です。migrationは明示的に適用します。

```sh
Copy-Item .env.example .env
pnpm --filter @easymtg/server db:migrate
```

`.env`に`DATABASE_URL`を設定してください。Docker Desktopを使う場合の例は `postgres://easymtg:easymtg-dev@localhost:5432/easymtg` です。

管理 API を使う場合は、`.env` の `ADMIN_API_TOKEN` に32 byte以上のランダムな秘密値を設定します。PowerShellで生成する場合：

```powershell
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
[Convert]::ToBase64String($bytes)
```

生成した値は秘密として管理し、信頼できる管理用Clientの`Authorization: Bearer <token>` headerでのみ送信してください。Token未設定時は管理API routeを登録しません。productionではHTTPSを使用し、ブラウザ向けアプリへtokenを埋め込まないでください。API payloadとendpointは [`spec/09-admin-api.md`](./spec/09-admin-api.md) を参照してください。

## 開発

```sh
pnpm dev
```

- Web: http://127.0.0.1:5173
- Server health check: http://127.0.0.1:3000/health

個別に起動する場合は `pnpm --filter @easymtg/web dev` または `pnpm --filter @easymtg/server dev` を実行します。

ブラウザからはWeb開発サーバーを開きます。Web開発サーバーは `/api` と `/ws` をServerへproxyし、最初の画面要求時にServerが設定した匿名Session Cookieを同じoriginの応答として返します。本番用Web成果物はServerが配信し、画面・HTTP API・WebSocketを同一originにまとめます。proxy先を変える場合は `API_PROXY_TARGET` を設定します（既定値 `http://127.0.0.1:3000`）。

## Lightsailへのデプロイ

Ubuntu 24.04 LTS上でNode.jsアプリとPostgreSQLを同居させる手順、systemd / Nginx設定、日次PostgreSQL backupの設定は [`deploy/lightsail/README.md`](./deploy/lightsail/README.md) を参照してください。Production起動前にmigrationを明示適用し、`.env`ではなくroot管理のEnvironmentFileで秘密情報を渡します。

## 検証

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

ゲーム仕様と技術仕様は `spec/README.md` から参照してください。実装状況は `spec/implementation-plan.md` に記録します。
