#!/bin/sh
# Daily PostgreSQL backup for docker-compose.prod.yml (service "backup").
#   BACKUP_HOUR (0–23, server time, default 3) · BACKUP_KEEP_DAYS (default 14) · BACKUP_NOW=1: one backup now, then exit
# Files: /backups/eip-YYYYmmdd-HHMM.dump (pg_dump custom format; restore with pg_restore, docs/canliya-alma.md).
set -eu
KEEP="${BACKUP_KEEP_DAYS:-14}"
HOUR="${BACKUP_HOUR:-3}"

run_backup() {
  file="/backups/eip-$(date +%Y%m%d-%H%M).dump"
  if pg_dump --format=custom --no-owner --file="$file.part"; then
    mv "$file.part" "$file"
    echo "[backup] $(date '+%F %T') ok: $file ($(du -h "$file" | cut -f1))"
  else
    rm -f "$file.part"
    echo "[backup] $(date '+%F %T') FAILED" >&2
  fi
  find /backups -name 'eip-*.dump' -type f -mtime +"$KEEP" -delete
}

if [ "${BACKUP_NOW:-0}" = "1" ]; then
  run_backup
  exit 0
fi

echo "[backup] daily at ${HOUR}:00, keeping ${KEEP} days in /backups"
while true; do
  now=$(date +%s)
  next=$(date -d "$(date +%F) ${HOUR}:00" +%s)
  [ "$next" -le "$now" ] && next=$((next + 86400))
  sleep $((next - now))
  run_backup
done
