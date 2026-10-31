# Reference and integration contract

Reference: https://github.com/Wangnov/Codex-App-Manager

Inspected commit: `31bd3f23f74d6e263cbeb86cb210f8fe64e281d4`.
Reviewed README, Windows update planning, Authenticode verification and package layout. The implementation adopts the management workflow with a new Electron backend so it can be built in this workspace without a Rust toolchain.

Update source: https://github.com/Wangnov/claude-app-mirror

Starting release supplied by the user: `claude-app-v3.1623.0`. This is not hard-coded in production.

## Contract

- GET `https://claudeapp.agentsmirror.com/latest/manifest`: schemaVersion 2; `sources.windows.x64`, `sources.windows.arm64`, `sources.macos.universal`, `sources.linux.x64`, `sources.linux.arm64`.
- Each selected entry must include a valid numeric `version`, exact expected `assetName`, positive bounded `contentLength`, and 64-character `sha256`.
- Mirror binaries: `/latest/win-x64`, `/latest/win-arm64`, `/latest/mac`, `/latest/linux-x64`, `/latest/linux-arm64`.
- Fallback metadata: GET `https://api.github.com/repos/Wangnov/claude-app-mirror/releases/latest`. Public repository, no credential required. Asset `digest` is preferred; pinned `SHA256SUMS.txt` is the fallback for older releases without digest.
- Fallback binaries: version-pinned `https://github.com/Wangnov/claude-app-mirror/releases/download/claude-app-v<VERSION>/<ASSET>`.
- GitHub source preference uses only GitHub. Automatic preference queries mirror and GitHub together and offers the newer version: the mirror manifest can lag behind GitHub releases. When GitHub is newer, only its version-pinned URL is used, because the mirror only serves `/latest`. When versions match, the mirror downloads first with GitHub as fallback. A failed GitHub request in this mode keeps the last GitHub release seen, so a rate limit does not make the offered version flip back. Request failures use exponential polling backoff capped at 30 minutes.
- Mirror `/latest` can change between manifest and download. SHA-256 and size mismatch reject those bytes and trigger the pinned GitHub fallback. Mismatching bytes are never installed.
- Metadata requests time out after 18 seconds; whole downloads after 30 minutes. Downloads are streamed to `.part`, hash-checked and renamed only on success. Cancellation removes partial data. HTTPS and approved hosts are enforced across redirects. Loopback HTTP is an explicit test-only constructor option, never exposed in the UI.
- Polling starts on app launch and runs while the process is alive. Default interval 1 minute. The upstream mirror polls approximately every 15 minutes; no push feed or zero-latency guarantee exists.

## Validation evidence

Local HTTP tests exercise the real client, streams, hashes, cache, timeouts and fallbacks. Platform installer calls in automated tests are controlled substitutes and never modify the host's Claude installation.

Postman CLI 1.75.0 simulation uses a deterministic manifest and inert package bytes based on the observed public contract. No owner workspace mock was searched: no authenticated Postman team workspace was selected. The simulation can be rerun without publishing or cloud login:

```powershell
npm exec --yes --package=postman-cli -- postman simulation run postman/simulations/claude-update.sim.yaml --port 4900 --no-history --output ndjson
# In another terminal:
node scripts/verify-simulation.cjs
```

The Postman CLI simulation startup was attempted but failed because the workspace sandbox does not permit access to its global `~/.postman` dataset directory. The same inert mock can be run directly with `node postman/mocks/claude-mirror/default.js`, then exercised using `node scripts/verify-simulation.cjs http://127.0.0.1:4901`. This fallback is a local HTTP integration check, not a successful Postman CLI simulation run.

Live manifest and read-only Windows detection are checked separately. Range reads of the actual x64 MSIX confirmed Identity Name `Claude`, Publisher CN `Anthropic, PBC`, version `3.1623.0.0`, and Application Id `Claude`, executable `app\Claude.exe`.

## Windows installation repair, 2026-10-22

The reported generic failure hid two useful native diagnostics: module autoload could select an incompatible `Microsoft.PowerShell.Security` module in the Windows PowerShell child; AppX deployment events also reported `0x80073D02` (package in use). Version 1.0.1 pins the system executable and security module, returns structured JSON errors, and uses `DeferRegistrationWhenPackagesAreInUse` without forced shutdown.

The existing downloaded `3.1623.1` x64 package was verified against the live manifest and the valid Anthropic signature, then passed through the actual repaired Manager installation flow. Windows accepted it with registration deferred: the registered version remained `3.1623.0.0`, so Manager persisted a pending update instead of reporting completion. The target is `3.1623.1`; completion is acknowledged only after native status reports that version or newer. Full error diagnostics, real system module loading, pending persistence/reconciliation, and no repeated installation are covered by regression tests. Uninstall remains unexecuted.

Deferred registration behavior: https://learn.microsoft.com/en-us/powershell/module/appx/add-appxpackage?view=windowsserver2025-ps#example-2-update-an-app-but-defer-registration-until-the-app-has-closed

## Service blocker and completion, 2026-10-22

Further inspection found CoworkVMService (display name Claude), running as LocalSystem from the old Claude package's `app\resources\cowork-svc.exe`. Its process image path was unavailable to ordinary process enumeration; the SCM service path identified its package ownership. AppX event 9641 reported an active service preventing deployment. Therefore a missing `Claude.exe` process did not establish that the package was idle.

Version 1.0.2 queries that service independently, pins its exact executable path to the installed package before controlling it, excludes that service PID from desktop-session detection, and gracefully stops/restores it around installation when the desktop is idle. `finally` restoration is attempted even after deployment failure; forced process termination is not used.

The repaired flow was run against the existing verified package: native registration advanced to `3.1623.1.0`, CoworkVMService was running again from the updated package, pending state was cleared, and no error was returned. UI retries after restart reuse the verified cached package rather than permanently disabling the action. Regression coverage includes native PowerShell service-operation substitutes for failure/restoration behavior; those tests never control real host services.

## Service shutdown race, 2026-10-31

Three "complete update" attempts for `4.4212.0` were each deferred (AppX events 638/658: running app `Claude_pzs8sxrjxfjjc!Claude`) while Manager saw no desktop process, and no 9641 (active service) was logged. CoworkVMService is a `WIN32_PACKAGED_PROCESS`, so its process carries the package identity; SCM can report Stopped while that process is still shutting down. Deploying in that window defers registration, and the `finally` restore then restarts the old service, so the deferral never completes. Installation now waits up to 60 seconds for the service process to exit before `Add-AppxPackage` (timeout aborts deployment and restores the service). Deferred results include Windows' structured reason from events 638/9641 for this package family, shown in the activity log and pending note.

Follow-up the same night: with that wait in place the next two attempts were still deferred (638 naming `Claude_pzs8sxrjxfjjc!Claude`, no 9641), with no Claude desktop process, the service process confirmed exited, and no user-visible process holding the identity (child processes of Claude such as the claude-code CLI carry no package identity). CoworkVMService is trigger-started (`\pipe\cowork-vm-service`), and a standard user cannot inspect identities of SYSTEM processes. When no desktop process exists immediately before deployment, installation now uses `-ForceApplicationShutdown` so Windows closes the package's leftover processes and registers the update; a running (or newly started) desktop still uses deferred registration.

## Download and install performance, 2026-10-31

The reference engine downloads with `curl -C -` (resume), `--retry 2`, a 120 s stall timeout and a single connection; MSIX installs use `-ForceUpdateFromAnyVersion` with forced shutdown. Measurements on this machine (system proxy) showed per-connection throttling: GitHub 1.65 MB/s with one connection, 5.35 MB/s with eight; mirror 3.26 → 6.03 MB/s with four. Version 1.0.4 therefore adds parallel ranged downloads over all version-pinned sources (mirror when its version matches, Anthropic's CDN URL from the manifest or the release's `release-manifest.json`, GitHub), chunk-level resume, and a 30 s stall timeout. A full 283 MB download took 47.8 s (previously ~13 min).

Deployment logs (event 613) showed staging a new version costs 37–83 s while registering an already staged package costs about 1 s, so verified downloads are staged immediately with `Add-AppxPackage -Stage`. The 94 s install on 2026-10-31 00:40 was Windows waiting for a hung `java.exe` that carried Claude's package identity (Application log 1002 at the end of the gap); identity-based detection now lists such programs and closes them only with the user's approval.

## GitHub metadata without the REST API, 2026-10-31

Unauthenticated REST API calls are limited to 60 per hour per IP, and conditional requests answered with 304 still count. With one-minute polling through a system proxy whose exit IP was shared, `GET /repos/.../releases/latest` returned 403 (`rate_limit` via proxy: 0/60; direct: 60/60). Each release ships `release-manifest.json` (schemaVersion 2, same shape as the mirror manifest, including SHA-256 and the pinned `downloads.claude.ai` URL). Version 1.0.5 reads it from `https://github.com/Wangnov/claude-app-mirror/releases/latest/download/release-manifest.json`, a release-asset download that does not consume the API quota, and only falls back to the REST API when the file is unavailable.
