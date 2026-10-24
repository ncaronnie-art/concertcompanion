# Concert Compass 0.2: local verification report

17 October 2026. Local code and generated media only. No live deployment, Codespace creation, billing changes, user footage or Apple signing.

## Results for this checkpoint

- Existing CompassCore tests: **45 passed, zero failures**, 0.448 seconds of test execution. Native source and test files were not changed.
- QualityCLI: **Swift release build passed**. It imports the same portable package; its only planner extension is a seed for regeneration.
- Python: **35 passed, zero failures**, 123.479 seconds. This includes all 13 original tests unchanged, 20 new guardrail tests and 2 new temporal-assembly stress tests.
- JavaScript and Python source syntax checked separately.
- UI/API bridge: **8 checks passed, zero JavaScript page errors** after the final renderer changes. Actual HTML/CSS fit 320, 390 and 1280 pixel viewports. The actual UI uploaded generated files through its chunk protocol, planned, edited, saved, rendered, prepared sharing and deleted test media through the real backend. The resulting 15-second file decoded and reached its end in Chromium using a test Blob.

**Do not confuse these with device evidence.** Direct Chromium navigation failed with ERR_BLOCKED_BY_ADMINISTRATOR; policy was not disabled. The separately labeled bridge runs the real UI offline and transfers API calls through an explicit test binding. Direct browser networking, Codespaces private-port authentication, iPhone Safari, operating-system sharing and Photos saving remain untested. No subjective concert-quality verdict exists.

## Reproducing the tests

Run only in an already authorized developer environment. These are maintainer commands, not work for the owner:

```sh
cd native/ConcertCompass && swift test -c release
cd ../../devtest && swift build -c release
python -m unittest discover -s tests -v
node --check static/app.js
python -m py_compile engine.py server.py tests/*.py tools/*.py
```

Optional Playwright scripts in `tools/` require an existing permitted Chromium/Playwright installation. `browser_smoke.py` exercises direct networking; it is blocked in this environment. `ui_bridge_check.py` is the isolated transport test described above. Write all evidence outside the repository. Neither script is served to the owner or loaded by the studio.

## Bugs discovered and repaired, not just new screens

**Cumulative timing:** a 40-shot test exposed half-frame disagreement between the Swift cursor's 600-Hz rounding and independently rounded source lengths. The Linux adapter now rounds absolute canonical boundaries to 30 fps, carries approved source durations separately and pads only fractional tails. Every midpoint in a 40-cut edit is checked for the correct colored picture and 440/660/880-Hz tone. This is stronger than checking only the first and last frame, but it is not a natural-speech lip-sync evaluation.

**Long-reel memory:** the prior all-input crossfade graph was killed during a 60-second test in a 4 GiB container; the container recorded an OOM kill. The new assembler decodes at most two shots at once, renders the body/transition pieces, and concatenates them. PCM intermediates prevent adding AAC encoder padding at every splice. The final complete MP4 encodes AAC once and preserves the piece boundaries. The previously failing 60-second test now passes. The final test command reported peak RSS of 369,136 KiB, versus 3,572,436 KiB in the earlier failing command. These are this synthetic test environment's process metrics, not a promise of real 4K/8K memory use.

**Upload reliability:** bounded 2 MiB pieces, idempotent replay, confirmed offsets, mismatch/hole rejection, safe cancellation, and a single reservation held through the analysis handoff replace a fragile single-request path. The legacy route remains for regression coverage. Retry across server restarts is not promised.

**Edit safety:** saved review precedes rendering; stale revisions cannot overwrite newer edits; locks protect source/trim/framing until explicit unlock; unsupported booleans, non-finite values and out-of-range trims are refused. The UI opens one source player rather than one decoder per moment. Source aspect is preserved in the proxy so manual framing is not previewed through pre-baked black bars.

**Honest success:** output checks include codecs, dimensions, duration, audio/video endpoint agreement, sampled frames, complete-file decoding and size. A partial output is not exposed as a finished reel. The session receipt explicitly says physical-phone testing is unverified; Photos saving and owner taste are separate user-entered answers. Source cleanup, explicit deletion and expiry are tested locally, not assumed from /tmp.

## Coverage and exclusions

Generated colors, moving test patterns, sine waves, silence, mixed aspect ratios and a tagged HEVC Main10/PQ fixture exercise the processing path. The latter is not a real iPhone Dolby Vision recording. Tested export cases include short cuts, short dissolves, 15-second multi-shot dissolves, 40 irregular cuts and a 60-second dissolve reel. Not every style/length/source combination or failure mode has been tested.

No security audit, production load test, accessibility certification, licensed-song recognition, performer tracking, stabilization, crowd-vocal isolation or real concert evaluation has occurred. Gentle cleanup is low-rumble filtering only. The native app and old Apple workflows were not modified or rerun. Historical Apple build success is separate evidence and does not validate this Linux renderer.

## Cost and access boundary

No Codespace was created. Its actual quota, spending protection, image build, startup, private forwarding and iPhone behavior are still open gates. Do not make a port public or introduce a paid fallback. The current code remains a private-development test, not a product launch.

GitHub primary documentation for the next gate:
- https://docs.github.com/en/codespaces/troubleshooting/troubleshooting-included-usage
- https://docs.github.com/en/billing/how-tos/set-up-budgets
- https://docs.github.com/en/codespaces/developing-in-a-codespace/forwarding-ports-in-your-codespace
- https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features

Canonical decisions, constraints and next action: PROJECT_CONTROL.md.
