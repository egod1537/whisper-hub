# Whisper Hub

Whisper Hub is a private transcription queue for one Apple Silicon Mac. A small React and Blueprint interface submits audio or video through the Fastify API, a durable SQLite FIFO queue hands one job at a time to a worker, and the worker calls a native macOS `whisper.cpp` server. Results are stored as TXT, SRT, VTT, or JSON.

**Metal inference does not run inside Docker.** Docker Desktop's generic Linux containers do not receive macOS Metal GPU passthrough. The API and worker are containers; `whisper-server` runs natively on the Mac and the worker reaches it through `host.docker.internal`.

## Architecture

```text
browser -> 127.0.0.1:4173 frontend (Nginx)
                    | same-origin /web-api and /health proxy
                    v
             Docker API -> /data/whisper-hub.sqlite + upload parts
                                |                 |
                  upload finalizer          Docker worker (1 job)
                  (stream assembly)               |
                                |                 |
                                +------ job source+
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
   openssl rand -hex 32 # API_KEY
   openssl rand -hex 32 # WEB_PROXY_TOKEN
   ```

   Put the two independent values after `API_KEY=` and `WEB_PROXY_TOKEN=` in `.env`. The latter is an internal provenance secret shared only by Nginx and the API; it is not a browser credential. Do not paste either value into commands retained in shell history if that is a concern. Keep `.env` mode-restricted:

   ```sh
   chmod 600 .env
   ```

3. Build and start the containers:

   ```sh
   docker compose build
   docker compose up -d
   docker compose ps
   curl --fail http://127.0.0.1:3000/health/ready
   curl --fail http://127.0.0.1:4173/healthz
   curl --fail http://127.0.0.1:4173/health/ready
   ```

   Open <http://127.0.0.1:4173>. The UI uses only same-origin `/web-api` and `/health` requests through Nginx. Nginx rewrites `/web-api` to the public API path and overwrites both the bearer credential and internal provenance header from its container environment. Neither secret is placed in the browser, local storage, cookies, URLs, or frontend bundle. The ordinary `/api` proxy explicitly removes the provenance header.

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

   curl --fail-with-body -X POST http://127.0.0.1:3000/api/v1/jobs/youtube \
     -H "Authorization: Bearer $API_KEY" \
     -H "Content-Type: application/json" \
     -H "Idempotency-Key: youtube-demo-001" \
     --data '{"url":"https://www.youtube.com/watch?v=VIDEO_ID","language":"auto","formats":["txt","srt","json"]}'

   curl --fail-with-body http://127.0.0.1:3000/api/v1/jobs/JOB_ID \
     -H "Authorization: Bearer $API_KEY"

   curl --fail-with-body -o transcript.txt \
     http://127.0.0.1:3000/api/v1/jobs/JOB_ID/results/txt \
     -H "Authorization: Bearer $API_KEY"
   ```

Logs and shutdown:

```sh
docker compose logs -f api upload-finalizer worker
docker compose stop api upload-finalizer worker
docker compose down
```

`compose down` does not remove `./data`. Never add `-v` or delete `./data` unless a deliberate reset is intended.

### Remote browser access through SSH

The frontend and API bind to loopback by default. From Windows or another trusted client, forward the frontend port instead of exposing it to the LAN:

```sh
ssh -L 4173:127.0.0.1:4173 yang@macmini
```

Then open <http://127.0.0.1:4173> on the client. Keep the terminal session open. Public exposure requires a separately reviewed authenticated TLS tunnel or reverse proxy; the shared API key is intended for one private operator, not public multi-user authorization.

## API behavior

All `/api/v1` routes and `/docs` require `Authorization: Bearer <API_KEY>`. Only `/health/live` and `/health/ready` are public and minimal. The generated contract is [backend/openapi.json](backend/openapi.json).

For the deployed service, open <https://api-whisper.mangagaki.net/docs> and use **Authorize** with the bearer token. The OpenAPI server is relative to the current host, so Swagger's **Try it out** calls the same deployment that served the documentation.

For files that may exceed an edge proxy's single-request limit, use the resumable CLI instead of the legacy multipart endpoint. It requires only Node.js 22, sends server-defined 20 MiB chunks with up to three concurrent requests, retries transient failures, and resumes an interrupted upload from the parts already accepted by the server:

```sh
set -a
. ./.env
set +a

WHISPER_HUB_URL=https://api-whisper.mangagaki.net \
WHISPER_HUB_API_KEY="$API_KEY" \
node scripts/upload-resumable.mjs /absolute/path/to/video.mp4 \
  --language ko \
  --formats txt,srt,json
```

Progress is written to stderr and the queued `jobId`, status, queue position, and authenticated job URL are emitted as JSON on stdout. Keep the API key in the environment rather than a command-line argument. Repeating the same command resumes the stable session; after a session has expired or been aborted, pass a new `--idempotency-key`.

- `POST /api/v1/jobs`: streaming multipart upload; fields are `file`, optional `language`, and optional comma-separated `formats`. `prompt` is rejected in the MVP.
- `POST /api/v1/jobs/youtube`: queues one HTTPS YouTube video, Shorts, or completed Live URL without holding the request open for the download. The worker validates metadata, rejects active live streams and over-duration media, downloads only the best audio stream, then uses the same conversion/transcription pipeline. Playlist-only and non-YouTube URLs are rejected. The route is limited to ten submissions per hour per API process.
- `POST /api/v1/uploads`: creates an idempotent resumable session. `PUT /uploads/:uploadId/parts/:index` accepts exact, SHA-256-protected binary chunks; `GET` is the authoritative resume state.
- `POST /api/v1/uploads/:uploadId/complete`: changes the session to `finalizing` and returns `202`. The separate finalizer streams parts into one job source, then `GET /uploads/:uploadId` changes to `completed` with the one queue job ID.
- `DELETE /api/v1/uploads/:uploadId`: aborts an incomplete session. A finalizing or completed session must be handled through its job instead.
- `GET /api/v1/jobs` and `GET /api/v1/jobs/:id`: cursor-based list and job state. Active YouTube downloads expose measured bytes and media conversion exposes FFmpeg's processed seconds as nullable `progress` (`current`, `total`, `unit`, `percent`). Other phases expose only the phase; transcription never reports a fabricated percentage.
- `GET /api/v1/jobs?origin=web|api|unknown`: filters the same queue by server-derived submission origin while retaining stable cursor pagination. `origin` groups this private single-owner service; it is not identity or an authorization boundary.
- `POST /api/v1/jobs/:id/pause`: queued jobs become held immediately. Processing jobs enter `pausing` while ffmpeg or the provider is cooperatively aborted, then become `paused`. A pause does not consume the automatic retry budget.
- `POST /api/v1/jobs/:id/resume`: a paused job returns to the end of the eligible FIFO with a new queue-entry timestamp. Transcription restarts from the beginning; partial Whisper progress is not checkpointed.
- `DELETE /api/v1/jobs/:id`: cancellation is permanent and idempotent. Queued/paused jobs cancel immediately; processing/pausing jobs set a cooperative cancellation flag. Provider and ffmpeg work are aborted where feasible, but cancellation can take time. Completed and failed jobs return a state conflict.
- `POST /api/v1/jobs/:id/retry`: failed jobs only. A manual retry keeps the job ID and attempt audit history, resets the automatic attempt counter/budget to `JOB_MAX_ATTEMPTS`, and is limited to five manual retries.
- `GET /api/v1/jobs/:id/results[/format]`: completed results only, streamed as attachments without exposing filesystem paths.
- `GET /api/v1/system/status`: authenticated provider reachability, queue counts, worker heartbeat freshness, active upload sessions, staged bytes, and finalizing count.

An `Idempotency-Key` is 1–128 visible ASCII characters. Reusing it with identical content/options returns the existing job or session; different metadata/options returns `409`. The legacy single request is capped at 250 MiB. Resumable sessions default to 2 GiB total with 20 MiB requests and at most three concurrent browser requests. Worker-side `ffprobe` still validates the assembled media and independent two-hour duration limit.

The browser accepts multiple local files in one selection and multiple YouTube URLs entered one per line (up to ten). One submit creates one independent FIFO job per item with the same language and output options. Local files are uploaded sequentially, while each file still uses three concurrent chunks, so a large batch cannot multiply browser memory or saturate the API-wide chunk limit. Successfully queued items remain queued if a later item fails, and the UI retains the unprocessed items for retry; the batch is intentionally not atomic.

The browser uses resumable uploads for every file. It measures upload progress only after the server accepts a complete chunk, then polls `assembledBytes` to show the asynchronous server assembly phase before announcing a queued job. It retries only network/429/5xx failures up to three times with backoff. Refreshing preserves only the currently active file's non-secret resume metadata (session ID, original filename/size/mtime, language, formats) in `localStorage`; the operator must reselect that local file. File bytes, pending browser selections, and credentials are never persisted by the UI.

Direct bearer-authenticated uploads are classified `api`. First-party browser uploads, including resumable sessions finalized later, are classified `web` only when the API receives the separate server-side proxy token. Client fields and ordinary headers cannot choose the origin. Both origins always use one shared worker and the same FIFO; neither has priority. Historical rows migrated by `0003_job_origin_and_controls.sql` are conservatively classified `api`.

The FIFO order is `(queue_entered_at, id)` among currently eligible queued jobs. Initial queue entry uses creation time; resume and manual retry receive a new queue-entry time. YouTube media is downloaded by the worker in the `fetching` phase, so it participates in the same FIFO and cooperative pause/cancel/retry behavior. Paused jobs have no queue position and cannot be claimed. A retry waiting for backoff does not block later eligible jobs. Queue position is best-effort, 1-based, and can change; there is no ETA.

## Worker and failure recovery

The worker reserves a job with a SQLite `BEGIN IMMEDIATE` transaction, assigns a unique lease/fencing token, increments its attempt, commits, then processes outside the transaction. A lease heartbeat runs at least once per second during active work. Every phase, completion, pause, cancel, and failure mutation checks the token, so an expired worker cannot commit after another attempt takes ownership. An expired processing lease is requeued when attempts remain or failed when exhausted; an expired `pausing` lease recovers to `paused` without spending an attempt. Retryable provider network, timeout, 429, and 5xx failures use bounded 10/30/60-second backoff. Invalid media, excessive duration, conversion failures, unsupported formats, and corrupt responses are terminal.

Input is converted with fixed `ffmpeg` arguments to mono 16 kHz signed 16-bit PCM WAV. FFmpeg's machine-readable `-progress` output updates the fenced job row with processed seconds; yt-dlp's progress template supplies downloaded and exact-or-estimated total bytes. These measurements are cleared at every phase or terminal-state transition. No user string enters a shell command. Outputs are written with restrictive permissions in a job-and-lease-specific temporary directory and atomically renamed into a lease-specific result directory before the fenced database completion. A stale attempt can remove only its own unpublished result, not a newer owner's files. Completed output is never overwritten.

`whisper.cpp v1.9.5` is requested with `/inference`, `response_format=verbose_json`, and the job language. SRT/VTT are produced only from real `start`/`end` segment timestamps. A provider response without reliable timestamps fails instead of inventing them. `auto` language detection requires the configured multilingual host model.

## Retention, cleanup, and privacy

Defaults are completed job retention 7 days, failed/canceled retention 3 days, completed/canceled source retention 1 day, and incomplete upload expiry 24 hours. Cleanup expires incomplete sessions, removes terminal-session staging and stale `.partial` files, and never removes a finalizing session or queued job source. Failed source files remain until failed-job expiry so an explicit retry remains possible. Active queued or processing jobs are never deleted.

Preview cleanup (no deletion):

```sh
docker compose run --rm worker node dist/cli/cleanup.js
```

Apply once:

```sh
docker compose run --rm worker node dist/cli/cleanup.js --apply
```

The standard Compose deployment starts cleanup automatically, applies the policy once at startup, and repeats every 24 hours:

```sh
docker compose up -d cleanup
```

`CLEANUP_INTERVAL_HOURS` changes the schedule. Cleanup permanently deletes expired job rows and media, removes terminal upload staging, purges completed upload-session metadata after completed-job retention, and retains expired/aborted upload status briefly before purging old session rows. Active, queued, processing, pausing, paused, and finalizing work is never removed. Back up first if recovery could be required. Stop automatic cleanup with `docker compose stop cleanup`; the next ordinary `docker compose up -d` starts it again.

## Backup, restore, reset, and upgrade

SQLite WAL files must not be copied blindly while writes are active. The included backup command uses SQLite's online backup API:

```sh
mkdir -p backups
docker compose run --rm -v "$(pwd)/backups:/backup" worker \
  node dist/cli/backup.js /backup/whisper-hub.sqlite
```

The backup command never runs migrations; it copies the schema exactly as it exists when invoked. Do not open `data/whisper-hub.sqlite` with the macOS host `sqlite3` process while containers are running. With Docker Desktop or OrbStack bind mounts, host and Linux VM file locks may not coordinate safely. Use the container backup command above, or stop every service that can open the database before host-side inspection.

For a backup consistent with media files, stop API, upload finalizer, and worker, run the database backup, then copy `data/uploads` and `data/results` while they remain stopped:

```sh
docker compose stop api upload-finalizer worker cleanup
docker compose run --rm -v "$(pwd)/backups:/backup" worker \
  node dist/cli/backup.js /backup/whisper-hub.sqlite
rsync -a data/uploads data/results backups/
docker compose up -d api upload-finalizer worker
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

Before running any Compose command from this version, add a new 32-byte-or-longer `WEB_PROXY_TOKEN` to the existing `.env` if it is not already present. This is a configuration-only prerequisite and does not touch the database.

```sh
git switch main
git pull --ff-only origin main
mkdir -p backups
docker compose run --rm -v "$(pwd)/backups:/backup" worker \
  node dist/cli/backup.js /backup/whisper-hub.pre-upgrade.sqlite
docker compose build
docker compose up -d
```

The backup is mandatory before an upgrade containing a database migration; do not let the `migrate` service alter running production storage first. For a media-consistent backup, use the stopped-service procedure above. Keep the backup until API, worker, finalizer, queue controls, and result downloads have been verified.

`origin/main` is the production deployment source of truth. Do not build an operational image from a dirty worktree or another branch.

The one-shot `migrate` service applies forward-only migrations before API, upload finalizer, and worker startup. Migration `0002_resumable_uploads.sql` adds persistent sessions, validated parts, and cross-process part claims. Migration `0003_job_origin_and_controls.sql` rebuilds the constrained job tables for provenance, queue-entry time, pausing/paused states, and fencing-compatible attempt outcomes, then adds origin to upload sessions. Migration `0004_youtube_sources.sql` adds the constrained `youtube` source type and `fetching` phase while preserving existing upload jobs and attempts. Migration `0005_progress.sql` adds nullable measured job progress and durable upload assembly bytes. No reset is required. To update `whisper.cpp`, review the official release and server contract, update the pinned tag and model checksum in `scripts/setup-macos-whisper.sh`, rerun tests and the native E2E, then rebuild on the host. Do not silently track `master`.

## API key rotation and network exposure

Generate new independent values, replace `API_KEY` and `WEB_PROXY_TOKEN` in `.env`, then recreate authenticated services:

```sh
docker compose up -d --force-recreate api upload-finalizer worker frontend
```

Existing direct API clients immediately lose access. The frontend proxy and API pick up both values when their containers are recreated. Both are timing-safe compared where applicable, redacted from structured logs, and required at production startup unless explicit `TEST_MODE=true` is used by tests.

The default API bind is `127.0.0.1`, not the LAN. Remote access requires an explicit authenticated TLS reverse proxy or a private network such as Tailscale. Do not change the Compose port to `0.0.0.0` without that layer. CORS is disabled unless exact `CORS_ORIGINS` are configured. Rate limiting is IP-based; when using a trusted reverse proxy, set `TRUST_PROXY=true` only after the proxy overwrites forwarding headers, or clients can spoof addresses. Rate limiting is process-local and is not a multi-host quota system.

`whisper-server` is an unauthenticated trusted dependency. Keep 8080 out of public and LAN ingress. Test actual exposure from another device after firewall changes. Docker Desktop and the native server both need a post-reboot strategy; Docker Desktop login startup plus a reviewed `launchd` unit for `start-macos-whisper.sh` is an operational option, not installed automatically by this repository.

The backend image pins the official platform-independent `yt-dlp` 2026.10.26 release by SHA-256 and supplies Python and ffmpeg in the container. URL validation accepts only canonical single-video IDs on the YouTube, YouTube Music, `youtu.be`, and YouTube No-Cookie hosts; subprocess arguments are passed without a shell, and downloader output paths are confined to the job staging directory. Defaults are a 60-second metadata timeout, 15-minute download timeout, `MAX_UPLOAD_BYTES` downloaded-file ceiling, and the shared `MAX_DURATION_SECONDS` media ceiling. Override the timeouts with `YOUTUBE_METADATA_TIMEOUT_MS` and `YOUTUBE_DOWNLOAD_TIMEOUT_MS`; `YT_DLP_PATH` is intended for development/testing only. Private, age-restricted, members-only, or otherwise inaccessible videos fail without cookies. Operators are responsible for downloading only content they are authorized to process and for complying with YouTube's terms and applicable law.

## Development and verification

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm openapi
```

Run the API and frontend separately during UI development:

```sh
pnpm --filter whisper-hub-backend dev:api
pnpm dev:frontend
```

Vite listens only on `127.0.0.1:4173`, reads the root `.env` server-side, and injects both secrets only into its `/web-api` development proxy. It also proxies ordinary `/api` as direct-API traffic and `/health` to `http://127.0.0.1:3000`. If the local API uses a different port, set the development-only proxy target; neither it nor either secret is included in the browser bundle:

```sh
VITE_PROXY_TARGET=http://127.0.0.1:33000 pnpm dev:frontend
```

Frontend production assets are built with `pnpm build:frontend`. `docker compose up -d` builds and starts the frontend, API, upload finalizer, and worker. Nginx adds bearer authorization and the provenance marker from server-side environment only on `/web-api`, and disables request buffering; the secrets are never compiled into browser assets. The 251 MiB Nginx ceiling retains the legacy multipart endpoint while resumable requests remain at 20 MiB. It never proxies the native provider port.

### Resumable upload limits and Cloudflare

The validated defaults are:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `MAX_RESUMABLE_UPLOAD_BYTES` | 2147483648 | Aggregate file ceiling (2 GiB) |
| `UPLOAD_CHUNK_SIZE_BYTES` | 20971520 | Exact non-final chunk size; capped at 20 MiB |
| `UPLOAD_SESSION_TTL_HOURS` | 24 | Incomplete session lifetime |
| `UPLOAD_MAX_ACTIVE_SESSIONS` | 20 | Uploading/finalizing session cap |
| `UPLOAD_MAX_STAGED_BYTES` | 4294967296 | Total active validated-part quota |
| `UPLOAD_MAX_INFLIGHT_CHUNKS` | 6 | API-wide active stream cap; each session is capped at three |
| `UPLOAD_FINALIZER_LEASE_SECONDS` | 900 | Recoverable assembly lease |

Cloudflare's proxied per-request upload ceiling is plan-dependent; its current connection-limit documentation lists 100 MB for Free and Pro. The 20 MiB chunk default stays comfortably below that request limit, but WAF rules and rate limits must also allow the authenticated chunk route. Do not solve proxy failures by exposing the origin or disabling authentication. Completion is asynchronous specifically so a 2 GiB local assembly does not hold an edge request open. See [Cloudflare connection limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/).

Provider downtime does not prevent a fully assembled upload from becoming a queued job. The existing worker retry policy handles provider reachability. `507 INSUFFICIENT_STORAGE` means the staged-byte quota or filesystem capacity must be cleared; the client retains resume metadata and can retry after the operator runs cleanup or adds capacity.

Linux CI runs frontend unit/component tests plus backend unit, API, queue/recovery, and worker integration tests with a fake provider and ffmpeg. It does **not** verify macOS Metal or the complete manual browser workflow. The real provider test is opt-in and requires an actual Korean WAV fixture:

```sh
RUN_NATIVE_WHISPER_E2E=1 \
NATIVE_WHISPER_FIXTURE=/absolute/path/to/korean-16khz.wav \
WHISPER_BASE_URL=http://127.0.0.1:8080 \
pnpm test
```

Before accepting a Mac mini deployment, submit both browser and direct API files and verify grouping while preserving shared FIFO order. Upload a file larger than 100 MB through the configured Cloudflare route. Pause an active job, resume it from the beginning, cancel another, and confirm no late result appears. Restart the worker while `pausing` and verify recovery to `paused`. Also exercise provider backoff, download UTF-8 TXT/SRT/JSON, and verify ports 3000 and 8080 from another host. This repository cannot claim those hardware and network checks passed until run on the target Mac.

## Scope

This is a private single-host MVP. The UI intentionally has one page and no accounts, users/tenants, waveform, browser recording, subtitle editor, public sharing, diarization, billing, or multi-host SQLite writers. Resumable uploads coordinate multiple API processes through the one local SQLite database, but this is not a multi-host object-storage design. For public or multi-host scale, move to a database/object-store/queue architecture and add identity, TLS, audit, and stronger distributed rate limits.
