# Clipnest camera simulator

Local stress / smoke tool that pretends to be **N Reolink-style cameras** uploading
clips to the Clipnest FTPS server over explicit TLS.

Useful for:

- Load-testing libunftp + the S3 scanner pipeline before a release
- Verifying a fresh deploy (fail2ban jail, `--force-recreate nginx`, TLS cert
  renewal, etc.) from outside the stack
- Reproducing multi-camera timing / quota behavior that is awkward to trigger
  by hand

It is **not** a real camera emulator — files are random bytes with
Reolink-style names (`CameraName_00_YYYYMMDDHHMMSS.mp4`), NOT real H.264 video.
The scanner / thumbnail worker pipeline will therefore fail to produce a
thumbnail from the fake mp4; that's expected. Pass `--with-thumbnails` to
also upload a matching `.jpg` sidecar and bypass the ffmpeg step.

## Install

```bash
cd tools/camera-sim
npm install
```

## Run against local dev

```bash
# Assumes docker-compose.dev.yml is up and a user/admin exists.
FTPS_PASSWORD=Admin1234test \
node simulate.js \
  --host 127.0.0.1 --port 21 \
  --user admin \
  --cameras 5 \
  --interval-ms 8000 \
  --file-size-kb 512 \
  --with-thumbnails \
  --insecure \
  --verbose
```

`--insecure` is required in dev because the FTPS cert is self-signed.

## Run against a live environment

```bash
FTPS_PASSWORD='…' \
node simulate.js \
  --host clips.example.com --port 21 \
  --user my-user \
  --cameras 10 \
  --interval-ms 15000 \
  --file-size-kb 2048 \
  --duration-s 600
```

Use a **dedicated test account** against production — never your real user.
The uploads land in that user's S3 prefix and count against their transfer
quota. Delete them from the UI / admin panel afterwards.

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `--host` | `127.0.0.1` | FTPS server hostname |
| `--port` | `21` | FTPS control-channel port |
| `--user` | `admin` (or `$FTPS_USER`) | FTPS username |
| `--pass` | `$FTPS_PASSWORD` | FTPS password |
| `--cameras N` | `3` | How many concurrent camera sessions |
| `--interval-ms MS` | `10000` | Target interval between uploads per camera |
| `--jitter-pct PCT` | `30` | Random jitter around the interval (±pct/2) |
| `--file-size-kb KB` | `1024` | Size of each simulated mp4 |
| `--duration-s SEC` | none | Auto-stop after SEC seconds |
| `--with-thumbnails` | off | Also upload a matching `.jpg` per `.mp4` |
| `--insecure` | off | Skip TLS cert validation (dev self-signed) |
| `--verbose` | off | Dump every FTP command and response |
| `--help` | — | Full usage message |

## Output

The simulator prints:

- A startup line with the resolved config
- Any connect / upload errors as they happen
- A `[stats]` line every 10 s
- On exit (SIGINT or `--duration-s` elapsed): a `[stats]` summary and a
  `[per-camera]` table (uploads, failures, MiB per camera)

## Exit codes

- `0` — normal stop (Ctrl-C or `--duration-s`)
- `1` — fatal error before any worker started
- `2` — bad CLI args (missing `--pass`)

## What gets uploaded where

Each worker is logged in as the same user, so every upload lands under that
user's S3 prefix:

```
{user_uuid}/YYYY/MM/DD/CameraName_00_YYYYMMDDHHMMSS.mp4
```

The path format matches `FILE_REGEX` in `server/services/scanner.ts`, so
`clipnest-event-manager` will scan the uploads into events. The scanner
groups files per camera per day; running N cameras produces N per-camera
event clusters in the user's grid view.

## Tips

- To test the fail2ban libunftp jail, point `--user` at a bogus name and
  watch `sudo fail2ban-client status clipnest-ftps` on prod after ~4 failed
  authentications — your sim client IP should appear in the ban list.
- `--cameras 50 --interval-ms 2000` is enough to saturate a small dev VM's
  upload throughput and exercise the bounded-concurrency paths in
  libunftp + the API's internal user lookup cache.
- If you see `500 Internal Server Error` on every upload, the FTPS
  container is likely unable to reach the internal API or Redis — tail
  `docker logs clipnest-clipnest-ftps-1` for the real cause.

---

# `download.js` — FTPS download stress

Companion to `simulate.js`. Walks the user's FTPS tree, collects every
`.mp4` it finds, then runs M concurrent workers that RETR files at random
into `/dev/null` and report MiB/s. Use it to characterise the **download**
side of the pipeline — libunftp RETR throughput, S3 GET latency, SSE-C
decryption cost at scale.

## Prerequisites

Files must already exist on the server. Typical flow:

1. Upload with `simulate.js` (ideally `--stress --duration-s 60 --cameras N`)
2. Immediately run `download.js` against the same account — uploads from
   today's UTC date get picked up automatically by `--discover-days 1`.

## Run against local dev

```bash
FTPS_PASSWORD=Admin1234test \
node download.js \
  --host 127.0.0.1 --port 21 \
  --user admin \
  --concurrency 10 \
  --duration-s 60 \
  --insecure
```

## Run against production (dedicated test account only)

```bash
FTPS_PASSWORD='…' \
node download.js \
  --host clips.example.com --port 21 \
  --user you@example.com \
  --concurrency 20 \
  --duration-s 60 \
  --discover-days 3 \
  --insecure
```

The 4 K reference load that matches `simulate.js --stress` is:

```bash
FTPS_PASSWORD='…' \
node download.js \
  --host clips.example.com --port 21 --user you@example.com --insecure \
  --concurrency 20 --duration-s 60 --discover-days 1
```

After it finishes you get a `[stats]` summary (total MiB, MiB/s, failures)
and a `[per-worker]` table.

## Flags

| Flag | Default | Meaning |
|---|---|---|
| `--host` | `127.0.0.1` | FTPS server hostname |
| `--port` | `21` | FTPS control-channel port |
| `--user` | `admin` (or `$FTPS_USER`) | FTPS username |
| `--pass` | `$FTPS_PASSWORD` | FTPS password |
| `--concurrency N` | `5` | Number of parallel downloaders |
| `--duration-s SEC` | `60` | Auto-stop after SEC seconds |
| `--discover-days N` | `1` | Walk `/YYYY/MM/DD/` for the last N UTC days |
| `--path PATH` | — | Only crawl this prefix (e.g. `2026/04/16`); overrides `--discover-days` |
| `--download-timeout-s SEC` | `300` | curl `--max-time` per RETR |
| `--insecure` | off | Skip TLS cert validation (dev self-signed) |
| `--verbose` | off | Log every download + discovery call |
| `--help` | — | Full usage message |

## Exit codes

- `0` — normal stop (Ctrl-C or `--duration-s`)
- `1` — fatal error before discovery finished
- `2` — bad CLI args (missing `--pass`)
- `3` — discovery returned zero `.mp4` files (nothing to download)

## Troubleshooting

- **`discovered 0 file(s)`**: either the user's tree is empty, or UTC-today
  has no uploads. Try `--discover-days 7` to widen the window, or pass
  `--path YYYY/MM/DD` explicitly.
- **Every RETR fails with `451` or `Connection reset`**: same TLS 1.2/1.3
  mismatch that affects uploads on old curl. The script pins `--tls-max
  1.2` client-side to avoid the libunftp rustls / OpenSSL 1.1.1f bug.
- **Throughput plateaus well below your link bandwidth**: bottleneck is
  server-side (libunftp + S3 GET + SSE-C). That's exactly what this tool
  exists to measure — capture a flame graph with `./scripts/profile-ftps.sh`
  while it runs.
