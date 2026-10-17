#!/bin/sh
# First-start certificate setup, run by the `init-certs` service on every
# `docker compose up`; it only does work while a certificate is missing.
#
# Creates a private CA plus two certificates in the `certs` volume:
#   - object storage (MinIO): encryption with per-account keys (SSE-C) is only
#     allowed over TLS, so the internal storage endpoint must speak HTTPS even
#     though it never leaves the compose network;
#   - FTP server: a self-signed certificate for cameras that use FTPS. Cameras
#     do not validate it. Replace fullchain.pem / privkey.pem with a real
#     certificate if your FTP clients do.
set -e

if [ ! -f /certs/public.crt ] || [ ! -f /certs/fullchain.pem ]; then
    # The base image has no openssl tool. It is installed from the image's own
    # Alpine release, so only the first start (or one after the certs volume
    # was removed) needs internet access.
    command -v openssl >/dev/null 2>&1 || apk add -q --no-cache openssl
fi

if [ ! -f /certs/public.crt ]; then
    echo "Generating the internal CA and the object-storage certificate..."
    openssl genrsa -out /certs/ca.key 2048
    openssl req -x509 -new -nodes -key /certs/ca.key -sha256 -days 3650 \
        -out /certs/ca.crt -subj '/CN=Clipnest internal CA'
    openssl genrsa -out /certs/private.key 2048
    openssl req -new -key /certs/private.key -out /tmp/server.csr -subj '/CN=minio'
    printf '[SAN]\nsubjectAltName=DNS:minio,DNS:localhost,IP:127.0.0.1\n' > /tmp/san.ext
    openssl x509 -req -in /tmp/server.csr \
        -CA /certs/ca.crt -CAkey /certs/ca.key -CAcreateserial \
        -out /certs/public.crt -days 3650 -sha256 \
        -extfile /tmp/san.ext -extensions SAN
fi

if [ ! -f /certs/fullchain.pem ]; then
    echo "Generating the FTP server certificate..."
    openssl req -x509 -newkey rsa:2048 \
        -keyout /certs/privkey.pem -out /certs/fullchain.pem \
        -days 3650 -nodes -subj "/CN=${FTP_HOST:-clipnest}" 2>/dev/null
fi

# The services run as unprivileged users; these keys never leave the volume.
chmod 644 /certs/private.key /certs/privkey.pem
echo "Certificates ready."
