#!/usr/bin/env bash
# LOCOXATL daily backup: the uploads volume and a consistent MySQL dump.
#
#   sudo install -m 750 deploy/backup-locoxatl.sh /usr/local/bin/locoxatl-backup
#   sudo /usr/local/bin/locoxatl-backup
#
# Cron (03:15 every day):
#   15 3 * * * root /usr/local/bin/locoxatl-backup >> /var/log/locoxatl-backup.log 2>&1
#
# The dump is a read-only logical copy: historical orders, order_items and catalogue rows are
# never modified by this script.

set -euo pipefail
umask 077

BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/locoxatl}"
UPLOAD_ROOT="${UPLOAD_ROOT:-/var/lib/locoxatl}"
UPLOAD_DIR="${UPLOAD_DIR:-$UPLOAD_ROOT/uploads}"
ENV_FILE="${ENV_FILE:-/var/www/locoxatl/.env}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

fail() { log "ERROR: $*"; exit 1; }

[ -d "$UPLOAD_DIR" ] || fail "upload directory $UPLOAD_DIR does not exist"
[ -r "$ENV_FILE" ] || fail "environment file $ENV_FILE is not readable"

# Reads one KEY=value pair without sourcing the file or echoing secrets.
read_env() {
  grep -E "^[[:space:]]*$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '\r' | sed -e 's/^"//' -e 's/"$//'
}

DB_HOST="$(read_env DB_HOST)"
DB_PORT="$(read_env DB_PORT)"
DB_USER="$(read_env DB_USER)"
DB_PASSWORD="$(read_env DB_PASSWORD)"
DB_NAME="$(read_env DB_NAME)"

[ -n "${DB_HOST}" ] && [ -n "${DB_USER}" ] && [ -n "${DB_NAME}" ] || fail "DB_HOST, DB_USER and DB_NAME must be set in $ENV_FILE"
DB_PORT="${DB_PORT:-3306}"

mkdir -p "$BACKUP_ROOT"
UPLOADS_ARCHIVE="$BACKUP_ROOT/uploads-$STAMP.tar.gz"
DATABASE_DUMP="$BACKUP_ROOT/mysql-$STAMP.sql.gz"

log "archiving $UPLOAD_DIR"
tar -czf "$UPLOADS_ARCHIVE" -C "$(dirname "$UPLOAD_DIR")" "$(basename "$UPLOAD_DIR")"
log "wrote $UPLOADS_ARCHIVE ($(du -h "$UPLOADS_ARCHIVE" | cut -f1))"

log "dumping database $DB_NAME"
MYSQL_PWD="$DB_PASSWORD" mysqldump \
  --host="$DB_HOST" \
  --port="$DB_PORT" \
  --user="$DB_USER" \
  --single-transaction \
  --quick \
  --routines \
  --no-tablespaces \
  --default-character-set=utf8mb4 \
  "$DB_NAME" | gzip -9 > "$DATABASE_DUMP"
log "wrote $DATABASE_DUMP ($(du -h "$DATABASE_DUMP" | cut -f1))"

# A backup that cannot be listed is not a backup.
tar -tzf "$UPLOADS_ARCHIVE" > /dev/null || fail "the uploads archive is unreadable"
gzip -t "$DATABASE_DUMP" || fail "the database dump is unreadable"

log "pruning backups older than $RETENTION_DAYS days"
find "$BACKUP_ROOT" -maxdepth 1 -type f -name 'uploads-*.tar.gz' -mtime "+$RETENTION_DAYS" -print -delete
find "$BACKUP_ROOT" -maxdepth 1 -type f -name 'mysql-*.sql.gz' -mtime "+$RETENTION_DAYS" -print -delete

log "backup complete"
