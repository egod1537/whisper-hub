WHISPER HUB / BLUEPRINT FRONTEND - CODEX IMPLEMENTATION CONTRACT
Target repository: https://github.com/egod1537/whisper-hub
Task: implement a minimal, functional transcription web interface IN THIS EXISTING REPOSITORY.
Read all files in this directory first. Inspect the actual backend source, OpenAPI, compose.yaml, package.json and README before editing. Existing backend implementation is authoritative. If contracts differ from this document, preserve backend behavior, adapt the UI, and report deviations. Do not replace or rewrite working backend services.

MVP GOAL
A single responsive web page, Blueprint visual language, upload one audio/video file, choose language and output formats, submit, see queue and processing state, cancel/retry, read transcript, and download outputs. Simple and practical. Not a full dashboard.

IMPLEMENTATION SEQUENCE
1) 01_TECH_STACK_AND_REPO_INTEGRATION.txt
2) 02_MINIMAL_UI_AND_LAYOUT.txt
3) 03_API_CLIENT_AND_CONTRACT.txt
4) 04_UPLOAD_AND_OPTIONS.txt
5) 05_QUEUE_RESULTS_AND_ACTIONS.txt
6) 06_DOCKER_DEPLOYMENT_AND_SECURITY.txt
7) 07_TESTING_ACCEPTANCE_AND_DELIVERY.txt

WORK RULES
- Use TypeScript, React, Vite, Palantir Blueprint v6 (compatible current pinned versions), pnpm monorepo.
- Backend-only project exists; add frontend/ without breaking it.
- No mock UI pretending API succeeds. Use fake transport only in automated tests.
- Keep CSS small; use real Blueprint components and styles rather than recreate them.
- Prefer narrow MVP scope over generic component libraries or speculative features.
- Validate behavior against current generated backend/openapi.json and backend source.
- All text in UI: Korean concise copy (keep code identifiers English).
- Maintain accessible focus, labels, keyboard access, and small-screen behavior.
- Run checks, document actual results, commit if workflow allows; never claim macOS native test completed unless actually run.

EXCLUSIONS
No accounts, billing, admin dashboard, waveform, diarization, translation, subtitle editor, browser recording, S3, SSE, WebSockets, notification system, analytics, drag-heavy layouts, or unnecessary routing.
