# Concert Compass: one project record

Version 0.2.0 | 17 October 2026 | Owner: Ronnie

**Current milestone:** a private quality-test studio around the existing Swift planner. Local rendering and transport tests pass. This is not a released app, a live Codespace, or a verified iPhone installation.

## The non-negotiables

Budget: $0. Device: iPhone. No personal Mac or PC. No software installs or personal development services on the work computer. No employer data, public media uploads, developer enrollment, signing credentials, new paid accounts, or public deployment.

Before recommending a route, prove the whole chain: owner access, original footage selection, processing, full preview, saving with audio, privacy, deletion, and a hard no-paid-overage boundary. A code build alone does not pass that chain. Never ask Ronnie to buy a solution merely to discover whether the output is useful.

## Canonical implementation

Repository: `ncaronnie-art/concertcompanion`.
Active branch: `native/codespaces-quality-test`.
Development baseline: `d1a07264437598055275a6136b809a485088a04c`.
Entry points: `devtest/server.py`, `devtest/engine.py`, `devtest/static/`.
The adapter imports `native/ConcertCompass` unchanged. No new replacement app was created. Main, the original web app, native source, old workflows, container configuration, billing and permissions are unchanged. Preserve the native-branch deployment guard and `[skip netlify]` in commit messages.

## What the owner gets in this build

The studio has retryable small-piece uploads, a visible story order, trim/replace/manual framing, reject/restore, locking, saved-review state and stale-tab protection. Source coverage calls out omitted clips rather than hiding them. One source player opens only when needed. Export requires explicit approval and presents the complete result, not the first clip.

The Linux renderer uses frame-aligned cuts and dissolves, original audio, optional gentle rumble filtering, 9:16 H.264/AAC MP4, complete-file decoding checks, cancellation cleanup, and source-copy deletion after success. A two-tap share preparation flow is implemented but not yet verified in iPhone Safari. Feedback and a downloadable receipt distinguish user answers from technical checks.

No crowd-voice separation, artist/song recognition, automatic subject tracking, trained visual editor, stabilization, or viral-performance claim. Prompt handling is the existing offline rules interpreter. Native AVFoundation remains a different renderer. Uploaded test originals are deleted after successful rendering, so further changes then require reimporting them.

## Evidence scoreboard

| Gate | Status | Evidence |
| --- | --- | --- |
| Existing portable Swift logic | PASS, 45 tests | core-tests.log |
| Swift quality adapter | PASS, release build | quality-build.log |
| Linux renderer and HTTP safety | PASS, 35 tests | final-python-tests.log |
| Forty irregular cuts | PASS, picture and tone checked at every cut midpoint | test_frame_alignment.py |
| Complete 60-second dissolve reel | PASS with generated sources | test_frame_alignment.py |
| Actual UI with local API bridge | PASS, 8 checks | ui-bridge-checks.json |
| Direct browser network path | BLOCKED by managed Chromium policy | browser-run.log |
| Codespaces image/start/private authentication | NOT TESTED | No Codespace created |
| Real iPhone upload/playback/share/Photos save | NOT TESTED | Owner device test required |
| Real concert quality and owner approval | NOT TESTED | No real footage used |
| Native installation | BLOCKED under current setup | No signed distribution route approved |

The UI bridge uses the real HTML/JavaScript and local backend with explicit test transport. It does not validate normal browser networking, private GitHub authentication, Safari, or the system share sheet. Do not roll it into an iPhone claim. See QA_REPORT.md for timings, limitations and reproducible commands.

## Single next gate

**Verify the owner's personal Codespaces remaining included compute/storage and a hard no-paid-overage boundary.** The account's billing screen and protections have not been verified. Do not create a Codespace, add a card, raise limits, remove unrelated payment methods, or make a forwarded port public. Resolve access from an actual screen or an authorized account read, not guessed menu directions. No owner code debugging or installations are required now.

Only after that gate: create one private development Codespace, confirm its setup and private port, then use two or three short clips for a 15-second end-to-end iPhone test. Delete it when finished. This is development testing, not a production hosting plan.

## Definition of worth using

The pass requires camera-roll upload, review controls, a complete rendered reel, in-sync sound in Safari, saving and replaying with sound in Photos, and cleanup. Omitted source coverage must be visible. Any broken link is a failed gate, not a successful handoff.

Ronnie's two creative questions: **Does this capture the night? Would I share it?** Neither answer is assumed. The studio records technical answers separately from those creative judgments. Prioritize the biggest failed criterion before adding features.

## Session and handoff rules

Saved edits last within the current running server session, not forever. Upload retry applies to bounded pieces in that session, not across every phone or server restart. Media lives outside git. Clear deletes test media; successful render deletes source copies; running-server expiry and next-start cleanup remove leftovers. None guarantees secure erasure. Deleting a Codespace is a separate owner action; stopping it is not deletion.

For the next assistant or collaborator: read this file and devtest/AGENTS.md first; inspect branch head before writes; use an expected-head guard; keep original tests; report real evidence and exact blockers. Do not invent agents or unscheduled background progress. Owner updates should be brief Project feedback, Login or Test messages.
