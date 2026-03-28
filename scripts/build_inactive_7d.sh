#!/usr/bin/env bash
set -euo pipefail

cd /opt/render/project/src

echo "[START] build_inactive_7d $(date -Is)"

psql "$DATABASE_URL" -f ./scripts/build_inactive_7d.sql

echo "[END] build_inactive_7d $(date -Is)"