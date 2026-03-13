#!/usr/bin/env bash
set -euo pipefail

cd /opt/render/project/src

SCRIPT_NAME="inactive_30d"
TS() { date -Is; }

log() {
  echo "[$1] ${*:2}"
}

# デフォルト値
: "${DRY_RUN:=0}"
: "${SEGMENT_KEY:=inactive_30d}"
: "${MESSAGE_FILE:=./messages/omise_intro.json}"
: "${SKIP_GLOBAL_EVER_SENT:=1}"
: "${INCLUDE_BOUGHT:=0}"
: "${BLAST_LIMIT:=50}"
: "${BLAST_OFFSET:=0}"

log start "script=${SCRIPT_NAME} ts=$(TS)"
log config "DRY_RUN=${DRY_RUN} SEGMENT_KEY=${SEGMENT_KEY} MESSAGE_FILE=${MESSAGE_FILE} SKIP_GLOBAL_EVER_SENT=${SKIP_GLOBAL_EVER_SENT} INCLUDE_BOUGHT=${INCLUDE_BOUGHT} BLAST_LIMIT=${BLAST_LIMIT} BLAST_OFFSET=${BLAST_OFFSET}"

# エラー時の見やすい終了ログ
trap 'rc=$?; if [ $rc -ne 0 ]; then log error "script=${SCRIPT_NAME} rc=${rc} ts=$(TS)"; fi' EXIT

# 実行
OUTPUT="$(
  DRY_RUN="${DRY_RUN}" \
  SEGMENT_KEY="${SEGMENT_KEY}" \
  MESSAGE_FILE="${MESSAGE_FILE}" \
  SKIP_GLOBAL_EVER_SENT="${SKIP_GLOBAL_EVER_SENT}" \
  INCLUDE_BOUGHT="${INCLUDE_BOUGHT}" \
  BLAST_LIMIT="${BLAST_LIMIT}" \
  BLAST_OFFSET="${BLAST_OFFSET}" \
  node send_blast_once.js 2>&1
)"

# nodeの生出力をそのまま表示
echo "${OUTPUT}"

# よく見る値を拾ってサマリ表示
roster_total="$(printf '%s\n' "${OUTPUT}" | sed -n 's/^roster_total=\([0-9][0-9]*\).*$/\1/p' | tail -n1)"
already_bought="$(printf '%s\n' "${OUTPUT}" | sed -n 's/^already_bought_users=\([0-9][0-9]*\).*$/\1/p' | tail -n1)"
excluded_by_keys="$(printf '%s\n' "${OUTPUT}" | sed -n 's/^excluded_by_keys_users=\([0-9][0-9]*\).*$/\1/p' | tail -n1)"
eligible="$(printf '%s\n' "${OUTPUT}" | sed -n 's/^eligible_targets.*=\([0-9][0-9]*\).*$/\1/p' | tail -n1)"
valid="$(printf '%s\n' "${OUTPUT}" | sed -n 's/^valid_targets=\([0-9][0-9]*\).*$/\1/p' | tail -n1)"
invalid="$(printf '%s\n' "${OUTPUT}" | sed -n 's/^valid_targets=[0-9][0-9]* invalid_targets=\([0-9][0-9]*\).*$/\1/p' | tail -n1)"
batches="$(printf '%s\n' "${OUTPUT}" | sed -n 's/^would_send_batches=\([0-9][0-9]*\).*$/\1/p' | tail -n1)"
slice_after="$(printf '%s\n' "${OUTPUT}" | sed -n 's/^BLAST_SLICE applied:.* after=\([0-9][0-9]*\).*$/\1/p' | tail -n1)"

log roster \
  "roster_total=${roster_total:-?} already_bought=${already_bought:-0} excluded_by_keys=${excluded_by_keys:-0} eligible=${eligible:-?} valid=${valid:-?} invalid=${invalid:-0}"

log blast \
  "slice_after=${slice_after:-?} batches=${batches:-0}"

if [ "${DRY_RUN}" = "1" ]; then
  log result "would_send=${slice_after:-0} dry_run=1"
else
  sent_count="$(printf '%s\n' "${OUTPUT}" | sed -n 's/^OK batch: \([0-9][0-9]*\).*$/\1/p' | awk '{s+=$1} END{print s+0}')"
  log result "sent=${sent_count:-0} dry_run=0"
fi

log end "script=${SCRIPT_NAME} ok ts=$(TS)"
trap - EXIT