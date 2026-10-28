# Whisper Hub

Whisper Hub is a private, backend-only transcription queue for one Apple Silicon Mac. Clients upload audio or video to a Fastify API, a durable SQLite FIFO queue hands one job at a time to a worker, and the worker calls a native macOS `whisper.cpp` server. Results are stored as TXT, SRT, VTT, or JSON.

**Metal inference does not run inside Docker.** Docker Desktop's generic Linux containers do not receive macOS Metal GPU passthrough. The API and worker are containers; `whisper-server` runs natively on the Mac and the worker reaches it through `host.docker.internal`.

## Architecture

```text
client -> 127.0.0.1:3000 API -> /data/whisper-hub.sqlite + uploads
                                      |
                                 Docker worker (1 job)
                                      |
                         host.docker.internal:8080
                                      |
                       native macOS whisper-server (Metal)
                                      |
                               /data/results
```

The API never runs inference or waits for a transcript. It returns `202`, and the independent worker owns media validation, conversion, provider calls, retries, and output publication. SQLite, uploads, and results live in the local `./data` bind mount; do not put this database on NFS/SMB or share it between multiple hosts.

## Prerequisites

- Apple Silicon Mac with Xcode Command Line Tools (`xcode-select --install`)
- Docker Desktop configured to start when the operator logs in
- Git and CMake (`brew install cmake` if needed)
- Node.js 22+ and pnpm 10 only for local development; production runs in Docker
- `ffmpeg` for local worker tests (`brew install ffmpeg`); the worker image already includes it

The native setup uses the pinned official `whisper.cpp` tag `v1.9.5`, enables `GGML_METAL`, downloads the multilingual `base` model, and verifies its published SHA-256. Korean and Japanese require a multilingual model such as `base`, not a `*.en` model.

## Secure local quickstart

1. Build and start the native provider in one terminal:

   ```sh
   ./scripts/setup-macos-whisper.sh
   ./scripts/start-macos-whisper.sh
   ```

   The start script uses the `v1.9.5` flags `--host`, `--port`, `-m`, and `-l`. It binds `0.0.0.0:8080` because Docker Desktop's VM must reach the host. Block port 8080 from LAN/public ingress with the macOS firewall and router rules. Do not expose it to the internet. Check it locally with:

   ```sh
   curl --fail http://127.0.0.1:8080/health
   ```

2. Create the service environment. `.env.example` contains no secret:

   ```sh
   cp .env.example .env
   openssl rand -hex 32
   ```

   Put the generated value after `API_KEY=` in `.env`; do not paste it into commands that will be retained in shell history if that is a concern. Keep `.env` mode-restricted:

   ```sh
   chmod 600 .env
   ```

3. Build and start the containers:

   ```sh
   docker compose build
   docker compose up -d
   docker compose ps
   curl --fail http://127.0.0.1:3000/health/ready
   ```

   Verify the host route from the worker network if provider connectivity fails:

   ```sh
   docker compose run --rm --entrypoint node worker -e "fetch('http://host.docker.internal:8080/health').then(async r=>{console.log(r.status,await r.text());process.exit(r.ok?0:1)}).catch(e=>{console.error(e.message);process.exit(1)})"
   ```

4. Load the API key into the shell without printing it, upload a file, and poll the returned URL:

   ```sh
   set -a
   . ./.env
   set +a

   curl --fail-with-body -X POST http://127.0.0.1:3000/api/v1/jobs \
     -H "Authorization: Bearer $API_KEY" \
     -H "Idempotency-Key: demo-001" \
     -F "file=@/absolute/path/to/sample.wav" \
     -F "language=ko" \
     -F "formats=txt,srt,json"

   curl --fail-with-body http://127.0.0.1:3000/api/v1/jobs/JOB_ID \
     -H "Authorization: Bearer $API_KEY"

   curl --fail-with-body -o transcript.txt \
     http://127.0.0.1:3000/api/v1/jobs/JOB_ID/results/txt \
     -H "Authorization: Bearer $API_KEY"
   ```

Logs and shutdown:

```sh
docker compose logs -f api worker
docker compose stop api worker
docker compose down
```

`compose down` does not remove `./data`. Never add `-v` or delete `./data` unless a deliberate reset is intended.

## API behavior

All `/api/v1` routes and `/docs` require `Authorization: Bearer <API_KEY>`. Only `/health/live` and `/health/ready` are public and minimal. The generated contract is [backend/openapi.json](backend/openapi.json).

- `POST /api/v1/jobs`: streaming multipart upload; fields are `file`, optional `language`, and optional comma-separated `formats`. `prompt` is rejected in the MVP.
- `GET /api/v1/jobs` and `GET /api/v1/jobs/:id`: cursor-based list and job state. Progress is a phase, never a fabricated percentage.
- `DELETE /api/v1/jobs/:id`: queued jobs cancel immediately; processing jobs set a cooperative cancellation flag. Provider and ffmpeg work are aborted where feasible, but cancellation can take time.
- `POST /api/v1/jobs/:id/retry`: failed jobs only. A manual retry keeps the job ID and attempt audit history, resets the automatic attempt counter/budget to `JOB_MAX_ATTEMPTS`, and is limited to five manual retries.
- `GET /api/v1/jobs/:id/results[/format]`: completed results only, streamed as attachments without exposing filesystem paths.
- `GET /api/v1/system/status`: authenticated provider reachability, queue counts, and worker heartbeat freshness.

An `Idempotency-Key` is 1–128 visible ASCII characters. Reusing it with identical bytes and options returns the existing job with `200`; different content or options returns `409`. Uploads are capped at 250 MiB by default. Worker-side `ffprobe` validates the actual media and the two-hour duration limit.

The FIFO order is `(created_at, id)` among currently eligible queued jobs. A retry waiting for backoff does not block later eligible jobs. Queue position is best-effort, 1-based, and can change; there is no ETA.

## Worker and failure recovery

The worker reserves a job with a SQLite `BEGIN IMMEDIATE` transaction, increments its attempt, commits, then processes outside the transaction. A lease heartbeat runs at most every 30 seconds. An expired processing lease is requeued when attempts remain or failed when exhausted. Retryable provider network, timeout, 429, and 5xx failures use bounded 10/30/60-second backoff. Invalid media, excessive duration, conversion failures, unsupported formats, and corrupt responses are terminal.

Input is converted with fixed `ffmpeg` arguments to mono 16 kHz signed 16-bit PCM WAV. No user string enters a shell command. Outputs are written with restrictive permissions in a job-specific temporary directory and atomically renamed before the database moves to `completed`. Completed output is never overwritten.

`whisper.cpp v1.9.5` is requested with `/inference`, `response_format=verbose_json`, and the job language. SRT/VTT are produced only from real `start`/`end` segment timestamps. A provider response without reliable timestamps fails instead of inventing them. `auto` language detection requires the configured multilingual host model.

## Retention, cleanup, and privacy

Defaults are completed job retention 7 days, failed/canceled retention 3 days, and completed/canceled source retention 1 day. Failed source files remain until failed-job expiry so an explicit retry remains possible. Active queued or processing jobs are never deleted.

Preview cleanup (no deletion):

```sh
docker compose run --rm worker node dist/cli/cleanup.js
```

Apply once:

```sh
docker compose run --rm worker node dist/cli/cleanup.js --apply
```

Enable the opt-in daily cleanup service:

```sh
docker compose --profile retention up -d cleanup
```

Cleanup permanently deletes expired rows and their job directories. Back up first if recovery could be required. Stop the cleanup profile with `docker compose --profile retention stop cleanup`.

## Backup, restore, reset, and upgrade

SQLite WAL files must not be copied blindly while writes are active. The included backup command uses SQLite's online backup API:

```sh
mkdir -p backups
docker compose run --rm -v "$(pwd)/backups:/backup" worker \
  node dist/cli/backup.js /backup/whisper-hub.sqlite
```

For a backup consistent with media files, stop API and worker, run the database backup, then copy `data/uploads` and `data/results` while they remain stopped:

```sh
docker compose stop api worker cleanup
docker compose run --rm -v "$(pwd)/backups:/backup" worker \
  node dist/cli/backup.js /backup/whisper-hub.sqlite
rsync -a data/uploads data/results backups/
docker compose up -d api worker
```

To restore, stop all services, move the current `data` directory aside, create a new `data`, copy the backed-up database to `data/whisper-hub.sqlite` plus the media directories, then start Compose. Moving the old directory aside makes rollback possible.

To deliberately reset all service data, stop services and move `data` to a dated quarantine directory; do not recursively delete a broad or unresolved path:

```sh
docker compose down
mv data "data.backup.$(date +%Y%m%d%H%M%S)"
mkdir data
docker compose up -d
```

For an application upgrade:

```sh
git pull --ff-only
docker compose build
docker compose up -d
```

The one-shot `migrate` service completes before API and worker startup. To update `whisper.cpp`, review the official release and server contract, update the pinned tag and model checksum in `scripts/setup-macos-whisper.sh`, rerun tests and the native E2E, then rebuild on the host. Do not silently track `master`.

## API key rotation and network exposure

Generate a new key, replace `API_KEY` in `.env`, then recreate API and worker:

```sh
docker compose up -d --force-recreate api worker
```

Existing clients immediately lose access. The key is timing-safe compared, redacted from structured logs, and required at startup unless explicit `TEST_MODE=true` is used by tests.

The default API bind is `127.0.0.1`, not the LAN. Remote access requires an explicit authenticated TLS reverse proxy or a private network such as Tailscale. Do not change the Compose port to `0.0.0.0` without that layer. CORS is disabled unless exact `CORS_ORIGINS` are configured. Rate limiting is IP-based; when using a trusted reverse proxy, set `TRUST_PROXY=true` only after the proxy overwrites forwarding headers, or clients can spoof addresses. Rate limiting is process-local and is not a multi-host quota system.

`whisper-server` is an unauthenticated trusted dependency. Keep 8080 out of public and LAN ingress. Test actual exposure from another device after firewall changes. Docker Desktop and the native server both need a post-reboot strategy; Docker Desktop login startup plus a reviewed `launchd` unit for `start-macos-whisper.sh` is an operational option, not installed automatically by this repository.

## Development and verification

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm openapi
```

Linux CI runs unit, API, queue/recovery, and worker integration tests with a fake provider and ffmpeg. It does **not** verify macOS Metal. The real provider test is opt-in and requires an actual Korean WAV fixture:

```sh
RUN_NATIVE_WHISPER_E2E=1 \
NATIVE_WHISPER_FIXTURE=/absolute/path/to/korean-16khz.wav \
WHISPER_BASE_URL=http://127.0.0.1:8080 \
pnpm test
```

Before accepting a Mac mini deployment, also queue three files and observe one processing job, restart the worker during processing and wait for lease recovery, stop/restart the native provider to exercise backoff, download UTF-8 TXT/SRT/JSON, and verify ports 3000 and 8080 from another host. This repository cannot claim those hardware and network checks passed until run on the target Mac.

## Scope

This is a private single-host MVP. It intentionally has no users/tenants, per-user quotas, public sharing, diarization, billing, resumable uploads, or multi-host SQLite writers. For multi-host or public scale, move to a database/object-store/queue architecture and add identity, TLS, audit, and stronger distributed rate limits.
