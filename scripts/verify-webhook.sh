#!/bin/bash
# ECM — Vérification fonctionnelle du webhook Messenger (Carokaz Mada)
#
# Démarre le serveur en mode « accès Meta uniquement » avec des valeurs de test
# jetables, puis vérifie les garanties de sécurité. Aucun secret réel n'est utilisé.
# Sortie : code 0 si tous les contrôles passent, 1 sinon.

set -u

PORT="${PORT:-3998}"
HOST=127.0.0.1
export PUBLIC_ACCESS_ENABLED=true
export HOST PORT
export VERIFY_TOKEN=test-verify-token-0123456789abcdefghijklmn
export META_APP_SECRET=test-app-secret-0123456789abcdefghijklmnop
export PAGE_ACCESS_TOKEN=test-page-token-0123456789abcdefghijklmn
export OPENAI_API_KEY=test-openai-key-0123456789abcdefghijklmn

LOG="$(mktemp)"
node server.js > "$LOG" 2>&1 &
SRV=$!
cleanup() { kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null; rm -f "$LOG"; }
trap cleanup EXIT

sleep 3
echo "--- journal de démarrage ---"
cat "$LOG"
echo
echo "=== Vérifications fonctionnelles ==="

fail=0
check() { # libellé attendu obtenu
  if [ "$2" = "$3" ]; then
    echo "  [OK] $1 -> $3"
  else
    echo "  [ÉCHEC] $1 -> attendu $2, obtenu $3"
    fail=1
  fi
}

code() { curl -s -m 5 -o /dev/null -w "%{http_code}" "$@"; }

check "GET /webhook (bon jeton) renvoie le challenge" 200 \
  "$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://$HOST:$PORT/webhook?hub.mode=subscribe&hub.verify_token=$VERIFY_TOKEN&hub.challenge=CHAL")"

challenge="$(curl -s -m 5 "http://$HOST:$PORT/webhook?hub.mode=subscribe&hub.verify_token=$VERIFY_TOKEN&hub.challenge=CHAL")"
check "le challenge est renvoyé tel quel" "CHAL" "$challenge"

check "GET /webhook (mauvais jeton) est refusé" 403 \
  "$(code "http://$HOST:$PORT/webhook?hub.mode=subscribe&hub.verify_token=MAUVAIS&hub.challenge=CHAL")"

check "POST /webhook sans signature est refusé" 403 \
  "$(code -X POST -H 'Content-Type: application/json' -d '{"object":"page","entry":[]}' "http://$HOST:$PORT/webhook")"

check "POST /webhook avec signature invalide est refusé" 403 \
  "$(code -X POST -H 'Content-Type: application/json' -H "x-hub-signature-256: sha256=$(printf x | sha256sum | cut -c1-64)" -d '{"object":"page","entry":[]}' "http://$HOST:$PORT/webhook")"

BODY='{"object":"page","entry":[]}'
SIG="$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$META_APP_SECRET" | awk '{print $2}')"
check "POST /webhook avec signature valide est accepté" 200 \
  "$(code -X POST -H 'Content-Type: application/json' -H "x-hub-signature-256: sha256=$SIG" -d "$BODY" "http://$HOST:$PORT/webhook")"

check "GET / (route interdite) est masqué" 404 "$(code "http://$HOST:$PORT/")"
check "POST /autre (route interdite) est masqué" 404 "$(code -X POST "http://$HOST:$PORT/autre")"

headers="$(curl -s -m 5 -D - -o /dev/null "http://$HOST:$PORT/webhook?hub.mode=subscribe&hub.verify_token=x" | tr -d '\r')"
for h in "Cache-Control: no-store" "X-Content-Type-Options: nosniff"; do
  if printf '%s' "$headers" | grep -qi "^$h"; then
    echo "  [OK] en-tête présent : $h"
  else
    echo "  [ÉCHEC] en-tête manquant : $h"
    fail=1
  fi
done

echo
if [ "$fail" -eq 0 ]; then
  echo "RÉSULTAT : tous les contrôles ont réussi"
else
  echo "RÉSULTAT : au moins un contrôle a échoué"
fi
exit "$fail"
