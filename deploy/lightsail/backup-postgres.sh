#!/usr/bin/env bash
set -euo pipefail

: "${PGHOST:=127.0.0.1}"
: "${PGPORT:=5432}"
: "${PGDATABASE:?Set PGDATABASE in /etc/easymtg/backup.env}"
: "${PGUSER:?Set PGUSER in /etc/easymtg/backup.env}"
: "${PGPASSFILE:?Set PGPASSFILE to a protected PostgreSQL password file}"
: "${AWS_REGION:?Set AWS_REGION in /etc/easymtg/backup.env}"
: "${S3_BUCKET:?Set S3_BUCKET in /etc/easymtg/backup.env}"
S3_PREFIX="${S3_PREFIX:-easymtg/postgres}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/easymtg-backup}"

mkdir -p -- "$BACKUP_DIR"
chmod 0700 "$BACKUP_DIR"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
dump_path="$(mktemp "$BACKUP_DIR/easymtg-$timestamp.XXXXXX.dump")"
dump_name="${dump_path##*/}"
trap 'rm -f -- "$dump_path"' EXIT

pg_dump \
  --format=custom \
  --no-owner \
  --no-privileges \
  --host="$PGHOST" \
  --port="$PGPORT" \
  --username="$PGUSER" \
  --dbname="$PGDATABASE" \
  --file="$dump_path"

aws s3 cp "$dump_path" \
  "s3://$S3_BUCKET/$S3_PREFIX/$dump_name" \
  --only-show-errors \
  --sse AES256 \
  --region "$AWS_REGION"

printf 'PostgreSQL backup uploaded to s3://%s/%s/%s\n' "$S3_BUCKET" "$S3_PREFIX" "$dump_name"
