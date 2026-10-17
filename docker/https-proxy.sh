#!/bin/sh
# Starts Caddy for the "https" profile of docker-compose.yml.
#
# The site address is the host name in PUBLIC_URL, so the domain is written
# once, in .env. PUBLIC_URL has to be https:// and a bare host name: Caddy
# listens on the standard ports 80 and 443 only, so a port or a path in it
# could never work. Say so here, loudly, instead of starting a proxy that
# serves nothing.
set -eu

host="${PUBLIC_URL:-}"
case "$host" in
    https://*) host="${host#https://}"; host="${host%/}" ;;
    *) host="" ;;
esac
case "$host" in
    ''|*[!A-Za-z0-9.-]*)
        echo "HTTPS is switched on (the \"https\" profile), but PUBLIC_URL is '${PUBLIC_URL:-}'." >&2
        echo "Set it in .env to https:// and your domain - no port, no path - for example" >&2
        echo "PUBLIC_URL='https://clips.example.com' - then run: docker compose up -d" >&2
        exit 1
        ;;
esac

export HTTPS_HOST="$host"
exec caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
