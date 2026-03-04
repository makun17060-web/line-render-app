#!/bin/bash
set -e

cd /opt/render/project/src

export SEGMENT_KEY=inactive_30d
export MESSAGE_FILE=./messages/omise_intro.json
export SKIP_GLOBAL_EVER_SENT=1

node send_blast_once.js