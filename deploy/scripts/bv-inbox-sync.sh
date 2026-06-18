#!/usr/bin/env bash
# Refresh the Postfix map of valid encrypted-inbox addresses from the DB.
# Value 'bvinbox:' both marks the address valid (virtual_mailbox_maps) and
# routes it to the bridge transport (transport_maps).
set -euo pipefail
OUT=/etc/postfix/vinbox
runuser -u postgres -- psql -tAF' ' -d blindvault -c \
  "SELECT local_part || '@yourdomain.com', 'bvinbox:' \
     FROM inbox_addresses \
    WHERE expires_at IS NULL OR expires_at > now()" > "$OUT.tmp"
mv "$OUT.tmp" "$OUT"
postmap "$OUT"
