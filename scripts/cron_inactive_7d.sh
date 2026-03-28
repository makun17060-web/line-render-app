#!/usr/bin/env bash
set -euo pipefail

cd /opt/render/project/src

echo "[START] inactive_7d send $(date -Is)"

DRY_RUN=${DRY_RUN:-0}
ONCE_ONLY=0 \
SEGMENT_KEY=inactive_7d \
MESSAGE_FILE=./messages/inactive_7d.json \
node send_blast_once.js

echo "[END] inactive_7d send $(date -Is)"