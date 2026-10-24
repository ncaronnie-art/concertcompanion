# Concert Compass: private quality test

This is a development-only browser front end and Linux renderer around the existing Swift CompassCore library. It does not replace the native app or prove its iPhone behavior. Source is isolated on `native/codespaces-quality-test`; the native iOS interface, existing web app and main branch are unchanged.

## Current status

The existing 45 portable tests and 13 new synthetic-media/HTTP tests passed in the local Linux test environment on October 17, 2026 UTC. See `QA_REPORT.md`. The five-minute compilation path still requires a fresh portable test run and a representative two-core Codespaces render before it can be called validated. The Codespaces image has not been built or launched, and an iPhone has not used this test yet. No Codespace, public deployment, paid account, or signing setup was created.

## Before starting any Codespace

Confirm the owner's remaining personal-account included compute and storage. Also verify that billable usage is blocked. An alert-only budget is not a spending cap. Do not add a payment method, remove an existing method, or enable paid usage. Account billing is not accessible through this project's connector, so this is an owner check, not an assumed configuration.

Use only the owner's personal account, not employer resources. Create at most one 2-core Codespace after that check. GitHub's `hostRequirements` field specifies minimum resources, not a maximum; verify the selected machine. Leave port 8765 Private. Do not configure prebuilds or use this as a public or production service.

## Test workflow after that approval

Create the Codespace from `native/codespaces-quality-test`, not main. Its configuration installs developer tools in the remote container, reruns the portable and synthetic tests, then starts the private server. Nothing is installed on the owner's computer. A failed setup check prevents the server from starting.

Open the private forwarded port after signing into GitHub. Use up to three source clips, each at most 5 minutes and 750 MB (2 GB total), without pre-trimming on the phone. Choose a 15-, 30-, 45-, or 60-second highlight, or intentionally confirm a 90-second, 2-, 3-, or 5-minute compilation. Long compilations remain vertical at 30fps and use a declared 720 × 1280 H.264/AAC profile; short highlights use 1080 × 1920. Describe the style, review the suggested source trims, approve/reject/reorder/lock moments, and render. Only one private render runs at a time. Download the finished MP4, upload it to `iCloud Drive/Concert Compass/02 Exports`, then play and save/replay it on the owner's iPhone before this route passes. The owner must also approve its editing quality.

The browser uploads files; it does not use MediaRecorder or canvas capture. HEVC decoding and H.264 rendering happen on Linux. This reduces dependence on browser encoding APIs, but does not prove the Codespaces authentication, file-picker, upload, playback or Photos-save round trip.

The local catalog indexes up to 500 user-selected MOV/MP4/M4V references in this tab, 25 rows at a time; indexing does not upload or analyze media. Exclude/restore and local playback leave originals untouched. Reloading or leaving the page requires reselecting files and exclusions; no media or catalog is persisted in browser storage. Matching filename/size/date metadata is only a reselection hint, not duplicate detection, and different files can explicitly be indexed separately. ZIP extraction is not supported. “Choose for me” selects eligible files in import order, not by musical quality; only explicit activation uploads and analyzes the bounded selection. The three-active-source, per-source duration/size, project-byte and render limits remain unchanged. Active sources stay in the current edit: use existing moment rejection or explicitly clear the test before choosing another set. Local catalog references survive session cleanup/export, but source copies and completed exports retain the existing deletion rules. This is not unlimited-source compilation; additional range splitting remains separate work.

## Engineering reproduction

In a development environment with Swift, Python 3 and FFmpeg:

```sh
bash devtest/prepare.sh
bash devtest/start.sh
```

`prepare.sh` builds the adapter that imports the existing CompassCore planner and runs the tests. `start.sh` refuses to run without its successful-setup marker. Rerun preparation after changing source. The configured image uses official Swift 6.2.4 on Ubuntu Noble; it still needs a real Codespaces build. Local verification used Swift 6.2.1, Python 3.13.5 and FFmpeg 7.1.5, so the setup tests must pass again in the target image.

## Limits and privacy

Only the bounded offline prompt interpreter is used; there is no remote language model or song/artist recognition. Rumble filtering is not crowd-voice removal. Stabilization and automatic performer tracking are excluded. Source previews show the whole frame; the finished output is cropped to 9:16.

Media stays outside the repository in per-session directories under `/tmp`. Source copies, proxies and intermediate files are deleted after a successful render. The completed MP4 remains for preview/download until explicit deletion or one hour of inactivity; an active long render has a three-hour absolute limit. Startup cleans interrupted prior sessions. This is logical file deletion, not a forensic secure-erasure guarantee. A stopped Codespace may retain files; delete the Codespace after testing, not merely its browser tab. Stopped Codespaces still consume storage quota, and this custom base image also counts toward storage.

The app has no media access logs, third-party scripts, API credentials or public-share endpoint. It uses session cookies, same-origin checks, CSRF tokens and range-limited media endpoints. GitHub authentication and Private port visibility are additional required controls, not optional deployment settings. No real concert media belongs in Git, Actions, logs or shared artifacts.

## Official references checked October 17, 2026

- Included usage, compute, storage and deletion: https://docs.github.com/en/codespaces/troubleshooting/troubleshooting-included-usage
- Spending controls and hard-stop budgets: https://docs.github.com/en/billing/how-tos/set-up-budgets
- Private forwarded ports: https://docs.github.com/en/codespaces/developing-in-a-codespace/forwarding-ports-in-your-codespace
- Development/testing-only terms: https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features
- FFmpeg filters: https://ffmpeg.org/ffmpeg-filters.html

Next gate: verify the owner's included usage and no-spend controls before any Codespace is created. Then test remote startup with synthetic media before a real phone-footage test.
