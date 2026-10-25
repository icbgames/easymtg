# AWS Lightsailへのデプロイ

この手順では、Ubuntu 24.04 LTSのLightsailインスタンス1台でEasyMTG、PostgreSQL、Nginxを運用します。NginxでHTTPSを終端し、HTTPとWebSocketの通信をループバック上のFastifyへ転送します。PostgreSQLとFastifyをインターネットへ直接公開しないでください。

## インスタンスとネットワーク

1. Ubuntu 24.04 LTSのLightsailインスタンスを作成し、アプリケーションのDNS名を静的IPアドレスへ向けます。
2. Lightsailのファイアウォールとインスタンス内のファイアウォールで、受信TCP 80番・443番を許可します。SSH（TCP 22番）は管理者のIPアドレスからのみ許可してください。TCP 3000番・5432番はインターネットから接続できないようにします。
3. リポジトリの`.node-version`に合うNode.js 24、PostgreSQL、Nginx、AWS CLI v2、およびNginxプラグイン付きCertbotをインストールします。Node.jsは`24.15`以上`25`未満が必要です。pnpmは次の手順でNode.jsのnpmからインストールします。
4. `easymtg`サービス用アカウントと`/opt/easymtg`アプリケーションディレクトリを作成し、リポジトリとロックファイルに基づく依存関係を配置します。デプロイしたソースコードとビルド成果物はデプロイ管理者が所有し、`easymtg`アカウントには読み取り・実行権限だけを付与します。

   ```sh
   sudo useradd --system --user-group --home-dir /var/lib/easymtg --create-home --shell /usr/sbin/nologin easymtg
   sudo git clone https://github.com/icbgames/easymtg.git /opt/easymtg
   sudo chown -R "$(id -un)":easymtg /opt/easymtg
   sudo chmod -R g+rX /opt/easymtg
   sudo install -d -o root -g root -m 0755 /etc/easymtg
   ```

## Node.jsとpnpmのセットアップ

EasyMTGはNode.js `24.15`以上`25`未満と、pnpm `11.19.0`を使用します。Ubuntu 24.04標準のaptリポジトリではNode.js 18系が入る場合があるため、Node.js 24系を提供するNodeSourceリポジトリを登録してインストールします。既にaptでNode.js 18を入れていても、先に削除する必要はありません。

```sh
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
apt-cache policy nodejs
sudo apt install nodejs

node --version
command -v node
sudo npm install --global pnpm@11.19.0
pnpm --version
command -v pnpm
```

`apt-cache policy nodejs`でNodeSource由来の`24.x`がCandidateになっていることを確認してからインストールしてください。インストール後、`node --version`が`v24.15.0`以上`v25`未満、`pnpm --version`が`11.19.0`であることを確認します。`command -v node`は`/usr/bin/node`、`command -v pnpm`は`/usr/bin/pnpm`または`/usr/local/bin/pnpm`のようなシステム共通の場所を示す必要があります。systemdサービスはシステム共通のコマンドを使うため、`nvm`等でログインユーザーだけに導入したNode.js / pnpmは使用しないでください。Corepack経由ではなく、バージョンを固定したpnpmをnpmから直接導入する手順です。

### aptでNode.jsの展開に失敗する場合

`dpkg-deb`のプロセスが`Killed`となる場合はメモリ不足（OOM）の可能性が高いですが、`unexpected end of file or stream`はディスク容量・inode不足でも起こり得ます。再試行する前に原因を確認してください。

```sh
free -h
df -h / /var/cache/apt/archives
df -i /
sudo journalctl -k -b --no-pager | grep -Ei 'out of memory|oom|killed process' | tail -n 30
```

空きメモリが不足し、カーネルログにOOMによる終了が記録されている場合は、空きディスク容量を確認したうえでLightsailのメモリを増やすか、インスタンスに一時的なswapを追加してから再試行してください。swapはメモリ増強の代替ではありません。ディスク容量またはinodeが不足している場合は、不要なファイルを整理して空きを確保します。原因を解消した後、apt/dpkgの中断状態を修復してNode.js 24を再試行します。

```sh
sudo apt clean
sudo dpkg --configure -a
sudo apt --fix-broken install
sudo apt install nodejs
node --version
```

`node --version`でNode.js 24系になったことを確認してください。`/usr/bin/node.dpkg-new`などを手動で削除したり、dpkgを強制実行したりしないでください。修復コマンドが再度失敗する場合は、エラー全文と上記の容量・メモリ・カーネルログを確認してから対応します。

### `libnode.so.109`が見つからない場合

これはNode.js 18系の実行ファイルが残っている一方で、その共有ライブラリが削除されたなど、aptによるNode.js更新が未完了の可能性があります。また、`/usr/local/bin/node`にある別の実行ファイルが`/usr/bin/node`より先に選ばれている場合もあります。どちらかを決めつけず、実際に選択されるパスとdpkgの状態を確認してください。

```sh
type -a node
ls -l /usr/local/bin/node /usr/bin/node
dpkg -l nodejs libnode109
apt-cache policy nodejs
/usr/bin/node --version
```

`/usr/bin/node --version`が成功し、`type -a node`で`/usr/local/bin/node`が先に表示される場合は、PATH上の古い実行ファイルが原因の可能性があります。`/usr/local/bin/node`がどのパッケージにも属さないことを`dpkg -S /usr/local/bin/node`で確認し、管理者が置いたファイルでないと確認できるまでは削除・移動しないでください。`/usr/bin/node`も同じエラーになる場合、またはNode.js 24になっていない場合は、容量・メモリ不足を解消した後、下記のdpkg修復手順を実行します。`libnode109`を単独で追加して18系の実行ファイルを動かすのではなく、Node.js 24のパッケージ一式を整合した状態にしてください。

### アプリサービスが`libnode.so.109`で再起動を繰り返す場合

アプリ用unitは`ExecStart=/usr/bin/node ...`を指定するため、migrationがNode.js 24で成功していても、`/usr/bin/node`がNode.js 18のまま壊れているとアプリだけが起動に失敗します。`Restart=on-failure`により再起動を繰り返すので、まずサービスを停止します。

```sh
sudo systemctl stop easymtg.service
type -a node
ls -l /usr/local/bin/node /usr/bin/node
sudo -u easymtg /usr/local/bin/node --version
```

`/usr/local/bin/node --version`が`v24.15.0`以上`v25`未満と確認できた場合、unitの起動パスをその実行ファイルに合わせます。

```sh
sudo systemctl edit easymtg.service
```

開いたoverrideに次を記載して保存します。

```ini
[Service]
ExecStart=
ExecStart=/usr/local/bin/node /opt/easymtg/apps/server/dist/index.js
```

systemdに再読込させ、失敗状態を解除してから起動とhealth checkを行います。

```sh
sudo systemctl daemon-reload
sudo systemctl reset-failed easymtg.service
sudo systemctl start easymtg.service
sudo systemctl status easymtg.service
curl --fail http://127.0.0.1:3000/health
```

これは正常に動作するNode.js 24実行ファイルへ切り替える対処です。根本的にはapt管理の`/usr/bin/node`をNodeSourceのNode.js 24パッケージで修復し、`/usr/bin/node --version`が24系になった後にoverrideを削除するか、配布unitを再インストールしてください。`/usr/local/bin/node`のバージョン確認が失敗する場合はoverrideせず、Node.jsパッケージを先に修復します。

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

### migration serviceが`203/EXEC`で失敗する場合

`status=203/EXEC`は、migration処理が始まる前にsystemdが`ExecStart`の実行ファイルを起動できなかったことを示します。たとえばユニットが`/usr/bin/pnpm`を指定していても、pnpmが`/usr/local/bin/pnpm`にインストールされていると起動できません。設定中のパスと実際のpnpmの場所を確認してください。

```sh
command -v pnpm
sudo -u easymtg "$(command -v pnpm)" --version
sudo systemctl cat easymtg-migrate.service
```

`sudo -u easymtg ... --version`が成功することを確認してください。`systemctl cat`に表示された`ExecStart`が`command -v pnpm`の出力と異なる場合は、`sudo systemctl edit --full easymtg-migrate.service`を実行し、`ExecStart`を実際の絶対パス（上記の`command -v pnpm`の出力）に合わせます。引数は`--filter @easymtg/server db:migrate`のままにしてください。ユニットファイルを更新した後、失敗状態を解除して再実行します。

```sh
sudo systemctl daemon-reload
sudo systemctl reset-failed easymtg-migrate.service
sudo systemctl start easymtg-migrate.service
sudo systemctl status easymtg-migrate.service
```

`ExecStart`のパスが一致しても失敗する場合は、`sudo journalctl -u easymtg-migrate.service -n 50 --no-pager`で詳細を確認してください。

### migration serviceで`28P01`（password authentication failed）が出る場合

`28P01`はPostgreSQLへの接続時に、`DATABASE_URL`のユーザー名またはパスワードがDBロールの認証情報と一致しなかったことを示します。ログに`../../.env not found`が出ても、本番環境では秘密情報を`/etc/easymtg/easymtg.env`から渡すため、それ自体は失敗原因ではありません。エラーに出ているDBユーザー名、環境ファイルの`DATABASE_URL`、PostgreSQLのロール名が一致しているか確認してください。接続URLやパスワードをログ・チャット・シェル履歴に貼らないでください。

確実に認証情報を揃えるには、PostgreSQL上でアプリケーション用ロールのパスワードを対話的に再設定し、同じパスワードを環境ファイルの`DATABASE_URL`へ反映します。

```sh
sudo -u postgres psql
```

psqlのプロンプトで次を実行します。パスワードは対話入力され、SQLコマンドやシェル履歴には含まれません。

```text
\password easymtg_app
\q
```

続いて、rootのみ読み書きできる環境ファイルを編集します。URL形式は`postgres://ユーザー名:URLエンコードしたパスワード@127.0.0.1:5432/データベース名`です。パスワードに`@`、`:`、`/`、`#`、`?`、`%`などが含まれる場合は、URLのuserinfo部分としてパーセントエンコードしてください。たとえば`@`は`%40`です。

```sh
sudoedit /etc/easymtg/easymtg.env
```

`DATABASE_URL`がロール`easymtg_app`とデータベース`easymtg`を指し、上で設定したパスワードと一致していることを確認して保存します。値を端末出力やチャットに表示して確認しないでください。EnvironmentFileはoneshot unitの起動ごとに読み直されるため、編集後はmigrationを再実行します。

```sh
sudo systemctl reset-failed easymtg-migrate.service
sudo systemctl start easymtg-migrate.service
sudo systemctl status easymtg-migrate.service
```

### migration serviceで`EROFS`が出る場合

ログに`ERR_PNPM_* EROFS`、`read-only file system`、`pnpm install`が表示される場合、pnpmが依存関係の再インストールを試みています。一方、migration unitの`ProtectSystem=strict`は`/opt/easymtg`を含むシステム領域を書き込み禁止にします。これはサービスの意図した制限なので、unitの保護設定を外したり、`chmod`で回避したりしないでください。前回の依存関係インストールがOOM等で中断していないか確認し、デプロイ管理者（例：`ubuntu`）として依存関係のインストールとビルドを完了してからmigrationを実行します。

```sh
cd /opt/easymtg
pnpm install --frozen-lockfile --network-concurrency=4
pnpm build
sudo chgrp -R easymtg /opt/easymtg
sudo chmod -R g+rX /opt/easymtg
sudo systemctl reset-failed easymtg-migrate.service
sudo systemctl start easymtg-migrate.service
sudo systemctl status easymtg-migrate.service
```

`pnpm install`や`pnpm build`は`sudo`や`easymtg`ユーザーでは実行しないでください。前者はデプロイ管理者が所有する作業ツリーへ書き込む必要があり、後者はsystemdサービスと同様に書き込みが制限されているためです。依存関係の再インストール自体がOOMで失敗する場合は、上記のOOM対処を行ってください。

### migration serviceが`oom-kill`で失敗する場合

`Result: oom-kill`および`signal=KILL`は、systemdがpnpmを起動した後、メモリ不足でLinuxのOOM killerがプロセスを終了したことを示します。実行ファイルのパスの問題ではありません。Node.jsのパッケージ展開時にもOOMが起きていた場合は、インスタンスのメモリが継続的に不足している可能性があります。再実行の前にRAM、swap、ディスクの空きを確認します。

```sh
free -h
swapon --show
df -h /
sudo journalctl -k -b --no-pager | grep -Ei 'out of memory|oom|killed process' | tail -n 30
```

Lightsailのプランを上げてRAMを増やす方法が最も確実です。プラン変更までの暫定策としてswapを追加する場合は、ルートディスクに2 GiB以上の空きがあることを確認してから実行します。既にswapが有効な場合や`/swapfile`が存在する場合は、重ねて作成せず状態を確認してください。

```sh
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
swapon --show
free -h
```

再起動後も有効にする場合は、`/etc/fstab`に`/swapfile none swap sw 0 0`を一度だけ追加します。swapはRAMの代替ではなく、処理が遅くなることがあります。swap追加後にmigrationを再試行し、引き続きOOMになる場合はRAMの大きいLightsailプランへ変更してください。

```sh
sudo systemctl reset-failed easymtg-migrate.service
sudo systemctl start easymtg-migrate.service
sudo systemctl status easymtg-migrate.service
```

リリースごとに、新しい通信を停止または排出してから、レビュー済みのリビジョンを配置します。`pnpm install --frozen-lockfile`と`pnpm build`を実行し、`sudo chgrp -R easymtg /opt/easymtg && sudo chmod -R g+rX /opt/easymtg`でグループの読み取り権限を更新します。続いて`sudo systemctl start easymtg-migrate.service`でマイグレーションを適用し、`sudo systemctl restart easymtg.service`でアプリケーションを再起動します。デプロイ前にマイグレーションとの互換性を確認し、スキーマ変更はexpand / deploy / contractの順で行ってください。適用済みスキーマが後方互換である場合に限り、アプリケーションコードをロールバックしてください。

マイグレーションコマンドは、リポジトリ内に`.env`がある場合のみ読み込みます。マイグレーション用systemdユニットから渡される環境変数が優先されます。本番環境の秘密情報は作業ツリーの外にある`/etc/easymtg/easymtg.env`で管理してください。

## NginxとHTTPS

Nginxをまだインストールしていない場合は、先にパッケージをインストールしてサービスを起動します。これにより`/etc/nginx/sites-available`などの標準ディレクトリも作成されます。ディレクトリを手動で作るのではなく、パッケージ管理でNginxを導入してください。

```sh
sudo apt update
sudo apt install -y nginx
sudo systemctl enable --now nginx
```

続いて、リバースプロキシの設定をインストールし、`server_name`を実際のDNS名（この環境では`easymtg.link`）に置き換えます。

```sh
sudo install -o root -g root -m 0644 deploy/lightsail/easymtg.nginx.conf /etc/nginx/sites-available/easymtg
sudoedit /etc/nginx/sites-available/easymtg
sudo ln -s /etc/nginx/sites-available/easymtg /etc/nginx/sites-enabled/easymtg
sudo nginx -t
sudo systemctl enable --now nginx
sudo systemctl reload nginx
curl --fail -H 'Host: easymtg.link' http://127.0.0.1/health
```

ローカルの確認が`{"status":"ok"}`になったら、CertbotのNginxプラグインを使って証明書を取得します。`your-domain.example`は例示用なので、コマンドには実ドメインを指定してください。

```sh
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d easymtg.link
sudo systemctl status certbot.timer
curl --fail https://easymtg.link/health
```

CertbotによってHTTPSとHTTPからHTTPSへのリダイレクトが有効になり、自動更新タイマーが稼働していることを確認します。`NODE_ENV=production`の場合、アプリケーションはセッションCookieにSecure属性を設定するため、公開サイトは必ずHTTPSにしてください。NginxはWebSocketのアップグレードヘッダーを付けて`/ws`をプロキシし、それ以外のリクエストも同一オリジンのFastifyへ転送します。

ブラウザーで`ERR_CONNECTION_REFUSED`になる場合は、DNS応答、Nginxの待受とサイト設定、HTTPS証明書の順に切り分けます。HTTPの80番でNginxの既定ページが返るときは、EasyMTGのサイト設定が有効化されていないか、`server_name`が実ドメインと一致していない可能性があります。HTTPSの443番が拒否されるときは、Certbotがまだ証明書を設定していない、またはNginxが443番で待ち受けていない可能性があります。

```sh
getent ahostsv4 easymtg.link
sudo nginx -t
sudo systemctl status nginx --no-pager
sudo ss -ltnp | grep -E ':(80|443)\b'
curl --fail -H 'Host: easymtg.link' http://127.0.0.1/health
sudo certbot certificates
```

外部からは`curl -v http://easymtg.link/health`および`curl -v https://easymtg.link/health`を実行して確認します。Lightsailのファイアウォールに加えて、UFW等のインスタンス内ファイアウォールでもTCP 80番・443番を許可してください。HTTPでNginxの既定ページが返る場合は`/etc/nginx/sites-available/easymtg`の`server_name`と`/etc/nginx/sites-enabled/easymtg`のリンク先を確認し、`nginx -t`とreload後にCertbotを実行します。443番が拒否される場合は、まず`certbot --nginx`の成功とNginxの443番待受を確認します。

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
