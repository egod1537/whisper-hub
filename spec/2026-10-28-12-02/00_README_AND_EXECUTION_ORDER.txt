WHISPER HUB — CODEX SPEC PACKAGE v1.0
Repository: https://github.com/egod1537/whisper-hub
Target: Apple Silicon Mac mini running Docker Desktop
Language: TypeScript, Node.js LTS, strict mode. Backend only, no frontend.

EXECUTION ORDER
1. 01_ARCHITECTURE_AND_RULES.txt
2. 02_DATABASE_AND_QUEUE.txt
3. 03_REST_API_CONTRACT.txt
4. 04_WHISPER_PROVIDER_AND_WORKER.txt
5. 05_DOCKER_MAC_DEPLOYMENT.txt
6. 06_TESTING_AND_ACCEPTANCE.txt
7. 07_SECURITY_AND_OPERATIONS.txt

Give Codex the entire package first for context. Implement in the above order, one milestone per prompt. After each milestone: run tests, document changed files and known issues, create commit only if authorized. No unrequested deployment or push.

NON-NEGOTIABLE: Docker Desktop on macOS does not provide Metal GPU passthrough into generic Linux containers. Native whisper.cpp / whisper-server runs ON MACOS HOST with Metal; TypeScript API and worker run in Docker containers. Use host.docker.internal for host connectivity. Never claim GPU access inside the container.

MVP PRODUCT: upload audio/video -> durable FIFO queue -> one transcription at a time -> persistent result -> TXT/SRT/VTT/JSON download -> status, cancellation, retry. Private deployment by default. Do not silently invent public multi-tenant functionality.

DEFINITION OF DONE: all contracts in these text files are implemented, automated tests pass, a real Mac mini sample transcription passes, README has exact runbook. If hardware is unavailable, clearly label live Metal E2E as unverified.
