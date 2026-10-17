# Concert Compass private quality test: verification report

Date: October 17, 2026 UTC
Status: LOCAL LINUX BACKEND VERIFIED; CODESPACES AND IPHONE NOT YET VERIFIED

## What was reused

The existing portable Swift package was recovered from the delivered native alpha archive. Its Package.swift, CompassCore source files, existing CLI and 45-test source were checked against the Git blob hashes on native/ios-alpha-0.1 at commit 2e681891fcb15fc5901c95a69acd249ae37f6b1c. They matched. The native source was not modified.

A separate adapter imports CompassCore for prompt rules, highlight planning, timeline generation and validation. FFmpeg performs the new Linux rendering. A small development UI is separate from both the native app and existing React app; the existing serve.ts was not reused or changed. This avoids modifying the current browser-rendering code for a temporary test.

## Verified in this execution

| Gate | Result | Evidence |
| --- | --- | --- |
| Existing portable Swift tests | PASS: 45 tests, 0 failures | swift test release log; 0.260 seconds of test execution, excluding build |
| QualityCLI adapter compilation | PASS | Swift release build log |
| New synthetic-media and HTTP tests | PASS: 13 tests | Python unittest log; final run 42.561 seconds |
| Browser JavaScript syntax | PASS | node --check devtest/static/app.js |
| Actual browser interaction | NOT VERIFIED | Chromium navigation was blocked by the execution environment policy: ERR_BLOCKED_BY_ADMINISTRATOR. No workaround was attempted. |
| Docker/devcontainer build and Codespaces start | NOT RUN | No Codespace or Docker build was launched. |
| iPhone upload, playback, share and Photos save | NOT RUN | No device or real concert footage was supplied for this harness. |
| Native AVFoundation regression run | NOT RUN in this execution | Historical GitHub native verification and unsigned-device workflows were checked as successful, but this harness does not exercise AVFoundation. |

Environment: Linux x86_64; Swift 6.2.1; Python 3.13.5; FFmpeg 7.1.5; Node 22.16.0. The intended remote image uses Swift 6.2.4/Noble and its package-manager FFmpeg. The tests rerun during Codespaces setup; local success is not proof of that image's compatibility.

## Thirteen new test cases

1. Existing Swift prompt interpreter and planner produce a supported edit list from analyzed synthetic media.
2. Hard-cut export preserves expected first/last picture and 440/880 Hz test-tone order, correct duration, and deletes sources after completion.
3. Dissolves and gentle rumble filtering finish with the expected duration and retained sound.
4. A silent source stays silent in a mixed-source reel.
5. Cancellation does not return a completed shareable reel.
6. The existing Swift validator rejects an out-of-bounds trim.
7. A stabilization request is explicitly rejected rather than faked.
8. Real local HTTP requests upload, analyze, plan, render, serve authenticated byte ranges, reject invalid ranges, and delete a test.
9. Session, CSRF, host/origin and upload-size guards reject selected invalid requests; navigation from GitHub to the landing page remains permitted.
10. Synthetic HEVC Main10 with PQ transfer tags is decoded and rendered to H.264 with BT.709 output tags.
11. Locked source ranges survive regeneration through the existing planner.
12. A complete 15-second, multi-shot dissolve edit renders within the duration tolerance.
13. Expired sessions remove their test-media directories.

These are functional tests, not a security audit, performance guarantee or judgment of artistic quality. The HEVC/PQ fixture is generated test imagery, not a real iPhone Dolby Vision capture. Longer 30/45/60-second Linux renders, sustained uploads and production-like load remain untested.

## Fixes made before the passing run

FFmpeg frame-rate/timebase handling at crossfades was corrected after an initial rendering failure. Explicit encoder color metadata was added so the HDR conversion test checks real stream metadata rather than relying on requested container tags. An asynchronous upload-worker closure was fixed. The request guard now allows a normal top-level navigation from GitHub while continuing to reject cross-site API requests. Polling does not continue indefinitely while the app is idle.

## Scope and controls

All inputs were generated colors, patterns and tones. No personal footage was used, uploaded, committed or included in test artifacts. No public service, Codespace, billing change, signing credential, enrollment or paid third-party service was created. Changes are confined to .devcontainer and devtest on a separate native-prefixed development branch. The existing deployment guard, workflows and native app remain unchanged.

Source copies are removed after a successful render; remaining media requires explicit deletion, running-server expiry, next-start cleanup or Codespace deletion. Stopping the Codespace does not guarantee deletion or stop storage quota use. No claim of secure erasure is made.

## What must happen before calling the route usable

Verify remaining personal-account compute/storage and a no-paid-overage boundary. Create one private 2-core Codespace only after that check, confirm its setup tests and authenticated private forwarding, then try two or three short phone clips and a 15-second reel. Pass only when the complete result plays with sound, saves and replays in Photos, the owner likes the edit, and the Codespace is deleted. Any break is a failed gate, not a finished app.

## Evidence and documentation

- Repository base: https://github.com/ncaronnie-art/concertcompanion/tree/2e681891fcb15fc5901c95a69acd249ae37f6b1c
- Historical Apple verification: https://github.com/ncaronnie-art/concertcompanion/actions/runs/38950269578
- Historical unsigned ARM64 package: https://github.com/ncaronnie-art/concertcompanion/actions/runs/38963825164
- Included usage/storage: https://docs.github.com/en/codespaces/troubleshooting/troubleshooting-included-usage
- Budget enforcement: https://docs.github.com/en/billing/how-tos/set-up-budgets
- Forwarding/privacy: https://docs.github.com/en/codespaces/developing-in-a-codespace/forwarding-ports-in-your-codespace
- Development-only terms: https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features

No native installation has been unblocked. This verifies a separate development renderer around reused editing logic, not an installable or released iPhone app.
