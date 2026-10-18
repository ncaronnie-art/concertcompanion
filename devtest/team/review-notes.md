# Independent QA review — quality sprint candidate

**Reviewer task:** `/root/cc_qa`
**Reviewed working revision:** uncommitted candidate on top of `033c355604d4da9d5f59debe062421bfed94e47d`
**Media used:** generated signals and mocked state only; no personal media, account, deployment, or paid service.

## Result

The candidate fixes the visible-settings refresh regression and wires a
non-mutating editorial recommendation into the server response and review UI.
It also routes the conservative audio policy through the renderer. The proposal
does not rewrite trims, locks, rejections, or manual framing.

I initially reproduced a startup-blocking import error:

```text
PYTHONPATH=devtest python3 -c 'import server'
ImportError: cannot import name 'propose_editorial_refinement' from 'editorial'
```

The lead corrected the import to `editorial.refine`. Reproduction after the
fix passed:

```text
PYTHONPATH=devtest python3 -c 'import server; print("server import passed")'
server import passed
```

## Evidence

```text
python3 -m unittest -v devtest.tests.test_sprint_integration \
  devtest.tests.test_audio_policy devtest.tests.test_editorial_refine \
  devtest.tests.test_picture_crop_policy devtest.tests.test_mobile_state

Ran 21 tests in 0.141s
OK (skipped=1)
```

The skipped test is the fresh-Chromium-document state-restoration test because
Playwright is not installed in this quality container. Its source-level
regression assertion passed. `git diff --check` also passed.

The test evidence specifically establishes:

- settings are restored from the saved server plan into the visible controls;
- the server returns editorial advice without changing the chosen moments;
- hostile synthetic phase-flip seam proxy drops from 1.6 to below 0.01 with a
  40 ms linear fade; stereo order and duration remain bounded;
- crop proposals preserve manual/locked framing and fall back for low
  confidence, obstruction, low light, or meaningful motion.

## Findings

### P0 — fixed before review sign-off

The initial `server.py` import referenced a symbol not exported by
`editorial/__init__.py`, preventing server startup. The corrected direct-module
import is now covered by the sprint integration test and the direct import
reproduction above.

### P1 — full candidate render remains unverified in this execution context

`devtest/.build/release/QualityCLI` is absent here, so the full Swift-planner +
FFmpeg generated-media suite could not be rerun against this exact candidate.
The 21 passing checks are unit/integration/UI-state evidence, not proof of a
complete candidate MP4. Do not claim an end-to-end render pass, direct browser
networking, Codespaces authentication, iPhone Safari, Photos saving, or owner
creative approval from this review.

### P2 — bounded crop helper is not yet called by the renderer

`propose_crop` has geometry coverage but no production call site in
`engine.py` or `server.py`. It is therefore a tested helper, not an active
reframing improvement. This is correctly distinct from artist tracking or
stabilization, neither of which is implemented.

### P2 — seam-smoothing option is transport/API-ready but not exposed in UI

`settings_from` accepts `seamSmoothing` and the renderer receives the policy,
but the shipping UI has no control that sends this field. Default behavior
remains the existing transition audio crossfade; do not advertise a new
user-selectable audio enhancement until the control and a complete render test
exist.

## Gates

| Gate | Status |
| --- | --- |
| Candidate imports and scoped integration | PASS |
| Generated-signal policy/geometry tests | PASS |
| Visible-settings restoration source contract | PASS |
| Fresh Chromium UI test | UNTESTED (Playwright absent) |
| Full Swift planner + FFmpeg candidate render | UNTESTED (QualityCLI absent) |
| Direct browser networking / private Codespaces auth | UNTESTED |
| iPhone Safari / Photos / real concert footage / owner judgment | UNTESTED |
| Billing/no-overage verification | UNTESTED; no spending authorized |

**Single next quality action:** run the existing full generated-media suite in
the approved private environment where `QualityCLI` is built, then inspect the
candidate MP4 before asking for the separate owner iPhone test.
