# AWS Lightsailへのデプロイ

この手順では、Ubuntu 24.04 LTSのLightsailインスタンス1台でEasyMTG、PostgreSQL、Nginxを運用します。NginxでHTTPSを終端し、HTTPとWebSocketの通信をループバック上のFastifyへ転送します。PostgreSQLとFastifyをインターネットへ直接公開しないでください。

## インスタンスとネットワーク

1. Ubuntu 24.04 LTSのLightsailインスタンスを作成し、アプリケーションのDNS名を静的IPアドレスへ向けます。
2. Lightsailのファイアウォールとインスタンス内のファイアウォールで、受信TCP 80番・443番を許可します。SSH（TCP 22番）は管理者のIPアドレスからのみ許可してください。TCP 3000番・5432番はインターネットから接続できないようにします。
3. リポジトリの`.node-version`に合うNode.js 24、pnpm 11.19.0、PostgreSQL、Nginx、AWS CLI v2、およびNginxプラグイン付きCertbotをインストールします。
4. `easymtg`サービス用アカウントと`/opt/easymtg`アプリケーションディレクトリを作成し、リポジトリとロックファイルに基づく依存関係を配置します。デプロイしたソースコードとビルド成果物はデプロイ管理者が所有し、`easymtg`アカウントには読み取り・実行権限だけを付与します。

   ```sh
   sudo useradd --system --user-group --home-dir /var/lib/easymtg --create-home --shell /usr/sbin/nologin easymtg
   sudo git clone https://github.com/icbgames/easymtg.git /opt/easymtg
   sudo chown -R "$(id -un)":easymtg /opt/easymtg
   sudo chmod -R g+rX /opt/easymtg
   sudo install -d -o root -g root -m 0755 /etc/easymtg
   ```

## PostgreSQL

PostgreSQLは`127.0.0.1`（およびUnixソケット）のみで待ち受けるように設定し、アプリケーション用ロールのパスワード認証には`scram-sha-256`を使用します。アプリケーション専用のデータベースとロールを作成し、PostgreSQLのスーパーユーザーをアプリケーションに使わないでください。

管理者が安全に生成・管理するランダムなパスワードを使って、PostgreSQLのアプリケーション用ロールとデータベースを作成します。たとえば`sudo -u postgres psql`でSQLからパスワードなしのロールを作成し、対話形式の`\password easymtg_app`コマンドでパスワードを設定します。

```sql
CREATE ROLE easymtg_app LOGIN;
CREATE DATABASE easymtg OWNER easymtg_app;
```

`/etc/easymtg/easymtg.env`をroot所有、mode `0600`のファイルとして作成します。

```ini
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
DATABASE_URL=postgres://easymtg_app:URL_ENCODED_PASSWORD@127.0.0.1:5432/easymtg
ADMIN_API_TOKEN=REPLACE_WITH_AT_LEAST_32_RANDOM_BYTES
```

データベースパスワードに予約文字が含まれる場合は、URLエンコードしてください。管理者トークンは暗号学的に安全な乱数から生成し、クライアント側コード、シェルの履歴、リポジトリ、ログに含めないでください。管理APIを使用しない場合は`ADMIN_API_TOKEN`を省略します。この場合、該当するルートは無効のままです。ファイルの所有者を`root:root`、権限を`0600`に設定します。systemdがこのファイルを読み込み、値をサービスへ渡します。

```sh
sudo install -o root -g root -m 0600 /dev/null /etc/easymtg/easymtg.env
sudoedit /etc/easymtg/easymtg.env
```

## ビルド、migration、サービス

`/opt/easymtg`で、デプロイ管理者としてロックファイルどおりに依存関係をインストールし、すべてのworkspaceをビルドします。次に、成果物を`easymtg`サービス用グループから読み取れるようにし、サービスユニットファイルをインストールします。

```sh
pnpm install --frozen-lockfile
pnpm build
sudo chgrp -R easymtg /opt/easymtg
sudo chmod -R g+rX /opt/easymtg
sudo install -o root -g root -m 0644 deploy/lightsail/easymtg.service /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/lightsail/easymtg-migrate.service /etc/systemd/system/
```

migrationを実行する前に、環境変数ファイルを設定してください。アプリケーションの初回起動時および更新時には、schema migrationを明示的に適用します。

```sh
sudo systemctl daemon-reload
sudo systemctl start easymtg-migrate.service
sudo systemctl enable --now easymtg.service
sudo systemctl status easymtg.service
curl --fail http://127.0.0.1:3000/health
```

リリースごとに、新しい通信を停止または排出してから、レビュー済みのリビジョンを配置します。`pnpm install --frozen-lockfile`と`pnpm build`を実行し、`sudo chgrp -R easymtg /opt/easymtg && sudo chmod -R g+rX /opt/easymtg`でグループの読み取り権限を更新します。続いて`sudo systemctl start easymtg-migrate.service`でマイグレーションを適用し、`sudo systemctl restart easymtg.service`でアプリケーションを再起動します。デプロイ前にマイグレーションとの互換性を確認し、スキーマ変更はexpand / deploy / contractの順で行ってください。適用済みスキーマが後方互換である場合に限り、アプリケーションコードをロールバックしてください。

マイグレーションコマンドは、リポジトリ内に`.env`がある場合のみ読み込みます。マイグレーション用systemdユニットから渡される環境変数が優先されます。本番環境の秘密情報は作業ツリーの外にある`/etc/easymtg/easymtg.env`で管理してください。

## NginxとHTTPS

リバースプロキシの設定をインストールし、`your-domain.example`を実際のDNS名に置き換えます。

```sh
sudo install -o root -g root -m 0644 deploy/lightsail/easymtg.nginx.conf /etc/nginx/sites-available/easymtg
sudo ln -s /etc/nginx/sites-available/easymtg /etc/nginx/sites-enabled/easymtg
sudo systemctl enable --now nginx
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx -d your-domain.example
```

CertbotによってHTTPSとHTTPからHTTPSへのリダイレクトが有効になり、自動更新タイマーが稼働していることを確認します。`NODE_ENV=production`の場合、アプリケーションはセッションCookieにSecure属性を設定するため、公開サイトは必ずHTTPSにしてください。NginxはWebSocketのアップグレードヘッダーを付けて`/ws`をプロキシし、それ以外のリクエストも同一オリジンのFastifyへ転送します。

## PostgreSQLの日次S3バックアップ

利用するAWSリージョンに非公開のS3バケットを用意します。S3 Block Public Accessを有効にし、既定の暗号化にSSE-S3を設定します。`easymtg/postgres/`プレフィックスだけを対象に、現行オブジェクトを30日後に削除するライフサイクルルールを追加します。バケットのバージョニングを有効にする場合は、旧バージョンも30日後に削除する設定を加えます。バックアップ用権限主体には、対象プレフィックス内のオブジェクトに対する`s3:PutObject`、`s3:AbortMultipartUpload`、`s3:ListMultipartUploadParts`だけを許可してください。バケットポリシーやライフサイクル設定を変更する権限は付与しません。

バックアップ用サービスアカウントと、アクセスを制限した認証情報ファイルを作成します。

```sh
sudo useradd --system --user-group --home-dir /var/lib/easymtg-backup --create-home --shell /usr/sbin/nologin easymtg-backup
sudo usermod -a -G easymtg easymtg-backup
sudo install -d -o easymtg-backup -g easymtg-backup -m 0700 /var/lib/easymtg-backup
sudo install -o root -g root -m 0600 /dev/null /etc/easymtg/backup.env
sudo install -o easymtg-backup -g easymtg-backup -m 0600 /dev/null /etc/easymtg/pgpass
sudo install -o root -g easymtg-backup -m 0640 /dev/null /etc/easymtg/aws-credentials
```

バックアップ専用のPostgreSQLログインロールを作成し、データベースへの`CONNECT`、アプリケーションスキーマへの`USAGE`、既存の全テーブルとシーケンスへの`SELECT`を付与します。将来作成されるテーブルとシーケンスにも、同じ既定の権限を設定します。スーパーユーザー権限は付与しないでください。パスワードは`easymtg-backup`所有、mode `0600`の`/etc/easymtg/pgpass`に、libpq標準形式で記述します。

```sql
CREATE ROLE easymtg_backup LOGIN;
GRANT CONNECT ON DATABASE easymtg TO easymtg_backup;
\c easymtg
GRANT USAGE ON SCHEMA public TO easymtg_backup;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO easymtg_backup;
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO easymtg_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE easymtg_app IN SCHEMA public GRANT SELECT ON TABLES TO easymtg_backup;
ALTER DEFAULT PRIVILEGES FOR ROLE easymtg_app IN SCHEMA public GRANT SELECT ON SEQUENCES TO easymtg_backup;
```

`\password easymtg_backup`でバックアップ用ロールのパスワードを設定します。`.pgpass`内のコロンは`\:`、バックスラッシュは`\\`にエスケープします。パスワードはURLエンコードしないでください。

```sh
sudoedit /etc/easymtg/pgpass
```

```text
127.0.0.1:5432:easymtg:easymtg_backup:PASSWORD_WITH_COLONS_ESCAPED
```

root所有、mode `0600`の`/etc/easymtg/backup.env`に設定値を記入します。

```ini
PGDATABASE=easymtg
PGUSER=easymtg_backup
AWS_REGION=YOUR_AWS_REGION
S3_BUCKET=YOUR_PRIVATE_BUCKET
S3_PREFIX=easymtg/postgres
```

```sh
sudoedit /etc/easymtg/backup.env
```

バックアップ用権限主体向けに、`/etc/easymtg/aws-credentials`へAWS CLI認証情報ファイルを設定します。`aws_access_key_id`と`aws_secret_access_key`を含む標準の`[default]`プロファイルを使用します。読み取り可能なユーザーを`root`と`easymtg-backup`に限定し（mode `0640`）、管理者のAWS認証情報を流用しないでください。この権限主体には設定したプレフィックスへのオブジェクトのアップロードに必要な権限だけを付与します。AWS認証情報やデータベースパスワードを`backup.env`、コマンド引数、ログに含めないでください。

```ini
[default]
aws_access_key_id = REPLACE_WITH_LIMITED_ACCESS_KEY
aws_secret_access_key = REPLACE_WITH_LIMITED_SECRET_KEY
```

```sh
sudoedit /etc/easymtg/aws-credentials
```

バックアップ用ユニットをインストールして有効にします。

```sh
sudo install -o root -g root -m 0644 deploy/lightsail/easymtg-backup.service /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/lightsail/easymtg-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now easymtg-backup.timer
sudo systemctl start easymtg-backup.service
sudo systemctl status easymtg-backup.service
sudo systemctl list-timers easymtg-backup.timer
```

タイマーは毎日03:00 UTC頃に実行され、最大15分のランダムな遅延が入ります。各実行でカスタム形式の`pg_dump`を作成し、SSE-S3で暗号化してアップロードした後、一時的なローカルコピーを削除します。30日間の保持はS3ライフサイクルの有効期限設定で実現します。`easymtg-backup.service`の実行失敗を監視し、バックアップに依存する前に、アップロードされたオブジェクトの日時を確認して本番以外のデータベースへのリストア訓練を実施してください。

## 運用と復旧

- `systemctl status easymtg.service`、`journalctl -u easymtg.service`、Nginx、PostgreSQL、ディスク容量、`GET /health`を監視します。
- `/health`はプロセスの稼働確認であり、データベースやバックアップの準備状況は確認しません。PostgreSQLとバックアップ完了状況は別途監視してください。
- 通常の停止・再起動時、systemdはSIGTERMを送信します。アプリケーションはSIGINT / SIGTERMを受け取るとFastifyを閉じ、クリーンアップワーカーを停止し、PostgreSQL接続プールを閉じます。
- 復旧目標はRPO 24時間、RTO 1日です。アプリケーションと同じインスタンスにデータベースを置くため、インスタンス障害から復旧するにはS3バックアップが必要です。ローカルdumpだけではバックアップになりません。
- 復旧時は代替インスタンスを用意し、互換性のあるPostgreSQLとアプリケーション依存関係をインストールしてデータベースとロールを再作成します。S3から選択したdumpをダウンロードし、アプリケーションを起動する前に代替データベースへリストアしてください。レビュー済みの復旧手順なしに稼働中のデータベースへ上書きリストアしないでください。
- 例として、別データベースへのリストアは`sudo -u postgres createdb --owner=easymtg_app easymtg_restore`を実行し、続けて`sudo -u postgres pg_restore --no-owner --no-privileges --role=easymtg_app --dbname=easymtg_restore /path/to/downloaded.dump`で行います。確認後、一時リストア用データベースを削除してください。
- 本番運用を始める前に、対象AWSアカウントで実際の認証情報、バケットポリシー、ライフサイクルの有効期限設定、バックアップタイマー、復元手順を検証してください。このリポジトリ変更によって本番インスタンスやAWSリソースが作成されることはありません。
