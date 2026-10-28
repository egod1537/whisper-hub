WHISPER HUB — CODEX IMPLEMENTATION SPECIFICATIONS
Feature: resumable chunked upload via Cloudflare reverse proxy
Target repository: https://github.com/egod1537/whisper-hub
Target: TypeScript Fastify backend + SQLite + React/Blueprint frontend + Docker Compose on Mac mini.

OBJECTIVE
Allow 100 MB+ media uploads through Cloudflare without exposing the Mac mini origin. Split a file into independent requests <= 20 MiB body; assemble only after all chunks are validated; atomically enqueue one existing Whisper job. Preserve existing single-request POST /api/v1/jobs and all current queue/worker contracts.

READ ALL FILES BEFORE CHANGING CODE. Inspect current repo first; adapt paths and function names to actual implementation. Do not overwrite existing completed backend/frontend work. No need to migrate SQLite to Postgres, add R2, or change native whisper.cpp setup.

IMPLEMENTATION ORDER
01 API/STATE -> 02 persistence -> 03 backend upload -> 04 finalization -> 05 frontend -> 06 security/operations -> 07 tests/deployment.
After each milestone: run lint, typecheck and relevant tests; record test commands and outcomes. Produce focused commits and an implementation report listing any deliberate deviations.

DEFAULTS
chunk size: 20 MiB (20*1024*1024 bytes)
max assembled upload: 2 GiB (2*1024*1024*1024 bytes), configurable
max concurrent in-flight chunks per upload: frontend 3, server configurable bounded concurrency
incomplete session TTL: 24 h, sliding only on successful authenticated chunk writes if desired and documented
retries: max 3 automatic retries per chunk with capped exponential delay; no retry for nonretryable 4xx
Storage: persistent local /data/uploads, same bind mount as worker; upload temp files under /data/uploads/.sessions; never /tmp in container.
Use existing Bearer API key authorization and origin limitations for all new endpoints.

CRITICAL INVARIANTS
- A session finalizes at most once and creates exactly one job ID.
- Never enqueue partial/unverified media.
- Never read entire large input into process memory.
- Survive API container restart and browser page reload.
- A partially uploaded session never becomes a visible queued/processing job.
- No user-controlled path is resolved outside the data root.
- Existing uploads and downloads remain backward-compatible.
- Keep Cloudflare proxied; do not encourage exposing an unproxied origin.
