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

exec "$@"
