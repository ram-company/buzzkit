#!/bin/bash
# Creates (or finds) the Pool BuzzKit Cloudflare resources and writes their ids into
# apps/api/wrangler.jsonc in place of the `PROVISION:<name>` placeholders. Safe to re-run.
#
#   pool/run pool/provision.sh
#
# Needs CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID. Hyperdrive also needs
# BUZZKIT_DATABASE_URL (the buzzkit role's PlanetScale connection string) and a token with
# Hyperdrive Edit; without them that step is skipped and its placeholder stays.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${CLOUDFLARE_API_TOKEN:?}" "${CLOUDFLARE_ACCOUNT_ID:?}"
API="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID"
CONFIG=apps/api/wrangler.jsonc

cf() {
  local method=$1 path=$2 body=${3:-}
  local response
  response=$(curl -sS -X "$method" "$API$path" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H "Content-Type: application/json" \
    ${body:+--data "$body"})
  if [ "$(jq -r '.success' <<<"$response")" != "true" ]; then
    echo "Cloudflare $method $path failed: $(jq -c '.errors' <<<"$response")" >&2
    return 1
  fi
  printf '%s' "$response"
}

fill() {
  local name=$1 id=$2
  if grep -q "\"PROVISION:$name\"" "$CONFIG"; then
    sed -i '' "s|\"PROVISION:$name\"|\"$id\"|" "$CONFIG"
    echo "filled $name"
  fi
}

kv_namespace() {
  local title=$1 id
  id=$(cf GET "/storage/kv/namespaces?per_page=100" | jq -r --arg t "$title" '.result[] | select(.title == $t) | .id')
  if [ -z "$id" ]; then
    id=$(cf POST /storage/kv/namespaces "$(jq -nc --arg t "$title" '{title: $t}')" | jq -r '.result.id')
    echo "created KV $title"
  fi
  fill "$title" "$id"
}

queue() {
  local name=$1
  if cf GET "/queues?per_page=100" | jq -e --arg n "$name" '.result | any(.queue_name == $n)' > /dev/null; then
    return
  fi
  cf POST /queues "$(jq -nc --arg n "$name" '{queue_name: $n}')" > /dev/null
  echo "created queue $name"
}

hyperdrive() {
  local name=pool-buzzkit-postgres id
  if [ -z "${BUZZKIT_DATABASE_URL:-}" ]; then
    echo "skipped Hyperdrive: BUZZKIT_DATABASE_URL is not set"
    return
  fi
  id=$(cf GET /hyperdrive/configs | jq -r --arg n "$name" '.result[] | select(.name == $n) | .id') || {
    echo "skipped Hyperdrive: this token cannot read Hyperdrive"
    return
  }
  if [ -z "$id" ]; then
    # Query caching off: preferences, tokens and delivery state must read their latest write.
    id=$(cf POST /hyperdrive/configs "$(bun -e '
      const url = new URL(process.env.BUZZKIT_DATABASE_URL);
      console.log(JSON.stringify({
        name: process.argv[1],
        origin: {
          scheme: "postgres",
          host: url.hostname,
          port: Number(url.port || 5432),
          database: url.pathname.slice(1),
          user: decodeURIComponent(url.username),
          password: decodeURIComponent(url.password),
        },
        caching: { disabled: true },
        origin_connection_limit: 10,
      }));' "$name")" | jq -r '.result.id')
    echo "created Hyperdrive $name"
  fi
  fill "$name" "$id"
}

kv_namespace pool-buzzkit-auth-cache
kv_namespace pool-buzzkit-provider-cache
kv_namespace pool-buzzkit-engine-definitions
for name in deliveries deliveries-dlq events events-dlq webhooks webhooks-dlq; do
  queue "pool-buzzkit-$name"
done
hyperdrive

if grep -q '"PROVISION:' "$CONFIG"; then
  echo "still unprovisioned: $(grep -o '"PROVISION:[^"]*"' "$CONFIG" | tr '\n' ' ')"
fi
