#!/bin/sh
# ---------------------------------------------------------------------------
#  Ensure a TLS certificate exists, then hand off to nginx.
#
#  A real certificate is supplied by mounting it over /etc/nginx/certs. When
#  nothing is mounted, a self-signed one is generated here so the image comes
#  up on first run rather than failing on a missing file. The browser warning
#  that produces is the point: it says, visibly, that this is not yet a
#  production certificate.
# ---------------------------------------------------------------------------
set -eu

CERT_DIR=/etc/nginx/certs
CERT=$CERT_DIR/server.crt
KEY=$CERT_DIR/server.key

if [ ! -f "$CERT" ] || [ ! -f "$KEY" ]; then
    echo "[tls] No certificate at $CERT_DIR - generating a self-signed one."
    echo "[tls] Mount a real certificate over $CERT_DIR for anything public."
    mkdir -p "$CERT_DIR"
    openssl req -x509 -nodes -newkey rsa:2048 \
        -days "${TLS_SELF_SIGNED_DAYS:-365}" \
        -keyout "$KEY" \
        -out "$CERT" \
        -subj "/CN=${TLS_COMMON_NAME:-localhost}" \
        -addext "subjectAltName=DNS:${TLS_COMMON_NAME:-localhost},DNS:localhost,IP:127.0.0.1" \
        2>/dev/null
    chmod 600 "$KEY"
    echo "[tls] Self-signed certificate written for CN=${TLS_COMMON_NAME:-localhost}."
else
    echo "[tls] Using the certificate mounted at $CERT_DIR."
fi

# ---------------------------------------------------------------------------
#  Where the two APIs are.
#
#  Compose names them from the ports the services were told to listen on
#  (ONTOLOGY_SERVICE_PORT, AI_FDE_PORT). The addresses used to be written into
#  nginx.conf as :4000 and :4100, so changing either port moved the service
#  and left nginx dialling the old one. They are filled in here instead. Only
#  these two names are substituted: nginx's own $host, $uri and the rest are
#  left exactly as written.
# ---------------------------------------------------------------------------
ONTOLOGY_SERVICE_URL=${ONTOLOGY_SERVICE_URL:-http://ontology-service:4000}
AI_FDE_URL=${AI_FDE_URL:-http://ai-fde:4100}
# No trailing slash: with one, nginx would forward /api/x as /x.
export ONTOLOGY_SERVICE_URL="${ONTOLOGY_SERVICE_URL%/}"
export AI_FDE_URL="${AI_FDE_URL%/}"
envsubst '${ONTOLOGY_SERVICE_URL} ${AI_FDE_URL}' \
    < /etc/nginx/default.conf.template > /etc/nginx/conf.d/default.conf
echo "[proxy] /api -> $ONTOLOGY_SERVICE_URL, /api/assistant -> $AI_FDE_URL"

exec "$@"
