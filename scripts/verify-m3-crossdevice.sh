#!/usr/bin/env bash
# Verify M3 cross-device collab-doc sync between two paired machines.
#
# Prereqs: both machines paired (same cluster token) with `anyd start` running,
# and each can see the other via `anyd peers`.
#
# This is a MANUAL, two-machine check — run the LEAD block on one machine and the
# WORKER block on the other, following the printed prompts. It does not delete or
# install anything; it only writes a collab doc under ~/.anytoany/collab/.
#
# Usage:
#   ./verify-m3-crossdevice.sh lead   <peer-device> [conversationId]
#   ./verify-m3-crossdevice.sh worker <peer-device>  <conversationId>
set -euo pipefail

ROLE="${1:-}"
PEER="${2:-}"
CONV="${3:-}"

if [[ -z "$ROLE" || -z "$PEER" ]]; then
  echo "usage: $0 lead <peer-device> [conversationId]"
  echo "       $0 worker <peer-device> <conversationId>"
  exit 1
fi

LEAD_LABEL="@claude:m3-lead"
WORKER_LABEL="@codex:m3-worker"

case "$ROLE" in
  lead)
    CONV="${CONV:-m3-verify-$(date +%s)}"
    echo "== LEAD on this machine, peer=@$PEER, conversationId=$CONV =="
    anyd collab init --conversation "$CONV" --as "$LEAD_LABEL" \
      --body "M3 verify: lead sets the plan. worker will add progress on @$PEER."
    anyd collab task "$CONV" --as "$LEAD_LABEL" --id t1 --owner "$WORKER_LABEL" --state working --step 1/2
    anyd collab progress "$CONV" --as "$LEAD_LABEL" "lead: plan written, pushing to @$PEER"
    echo "-- pushing to @$PEER --"
    anyd collab sync "$CONV" --to "@$PEER"
    echo
    echo "NOW on @$PEER run:"
    echo "  $0 worker <this-device> $CONV"
    echo "then back here run:  anyd collab show $CONV   # you should see the worker's line"
    ;;
  worker)
    if [[ -z "$CONV" ]]; then echo "worker needs the conversationId from the lead"; exit 1; fi
    echo "== WORKER on this machine, peer=@$PEER, conversationId=$CONV =="
    echo "-- what the lead synced to us: --"
    anyd collab show "$CONV"
    anyd collab progress "$CONV" --as "$WORKER_LABEL" "worker: endpoint done 2/2, syncing back to @$PEER"
    echo "-- pushing back to @$PEER --"
    anyd collab sync "$CONV" --to "@$PEER"
    echo
    echo "DONE. Back on @$PEER run:  anyd collab show $CONV"
    echo "Both machines should now show BOTH progress lines (converged)."
    ;;
  *)
    echo "unknown role: $ROLE (use 'lead' or 'worker')"; exit 1 ;;
esac
