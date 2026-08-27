#!/usr/bin/env bash
set -euo pipefail

# Local development against a loopback bos-server, driven by the Slack CLI.
# Set SLACK_CHANNEL_ID and SLACK_APPROVER_USER_IDS for your own workspace;
# there are deliberately no defaults, so a stray run cannot post into someone
# else's channel.
BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$BRIDGE_DIR/.local"

: "${SLACK_CHANNEL_ID:?set SLACK_CHANNEL_ID to your approvals channel id}"
: "${SLACK_APPROVER_USER_IDS:?set SLACK_APPROVER_USER_IDS to the approver user id}"
export SLACK_CHANNEL_ID SLACK_APPROVER_USER_IDS
export BOS_URL="${BOS_URL:-http://127.0.0.1:4410}"
export BOS_ALLOW_OPEN_DEV="${BOS_ALLOW_OPEN_DEV:-1}"
export STATE_FILE="${STATE_FILE:-$BRIDGE_DIR/.local/state.json}"

cd "$BRIDGE_DIR"
exec slack run "$@"
