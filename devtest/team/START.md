# Concert Compass: launch the quality sprint

**Prepared, not running.** These are five executable Codex role definitions and a coordinated work order, not evidence that five agents have been launched. No deployment or spending is authorized by this file.

## Mission

Improve the existing Concert Compass until a real concert reel earns the owner's approval. The first deliverable is **one integrated candidate plus a baseline/candidate comparison**, not five disconnected prototypes, another architecture proposal, or more decorative screens.

Use `native/codespaces-quality-test` in `ncaronnie-art/concertcompanion`. The inspected baseline is `da21e5dd98482daf27075195b2fb5f50477f1f1d`. Fetch current HEAD before any write; reconcile newer work rather than resetting it. Read `devtest/AGENTS.md` and `devtest/PROJECT_CONTROL.md`. The earlier 45 Swift and 35 Python passes are recorded baseline evidence, not proof of this sprint's improvements. Rerun appropriate tests.

## Activation: lead agent owns this

1. Confirm this is an already-authorized coding environment with access to this repository and included usage. Do not create an API account, buy credits, change permissions, use employer resources without authorization, or start a paid service. A quota or permission block stops the affected task.
2. Inspect the **actual** available subagent tools. Use `.codex/agents/cc_*.toml` when project-defined agents are supported. If a runtime supports built-in workers but not custom names, pass the exact specialist instructions to a built-in worker. This does not authorize bypassing an unavailable or administrator-disabled agent capability.
3. Launch no more than three workers concurrently. Record runtime-issued task IDs, role, base revision, allowed paths and actual status in a local run ledger outside git. A filename, prompt, test subprocess, or imagined specialist is not a running agent. If no launch tool exists, report that narrow blocker; do not pretend to have delegated work.
4. Keep private run details, credentials, personal-media paths and footage out of the public repository. `sprint.json` is the prepared plan, not a live monitor. A separate local ledger must reflect real launches.

## Five specialist work packages

| Role | First implementation | Quality evidence |
| --- | --- | --- |
| `cc_editor` | Better story pacing, variety and restrained transition proposals around the current edit list | Before/after edit decisions; no lost locks, rejected ranges or required clips |
| `cc_audio` | Conservative click/seam handling and an optional cleanup policy | Timing, tone, transient and stereo preservation; raw comparison; no crowd-removal claim |
| `cc_picture` | Correct manual reframing and a guarded motion/crop helper | Known-target crop and jitter/pan tests; safe fallback, no invented pixels or identities |
| `cc_mobile` | Recoverable camera-roll upload, visible saved state, review and share controls | Actual UI tests; interruption/reload behavior; no Safari claims from emulation |
| `cc_qa` | Independent adversarial tests and before/after review | Reproduced failures, integrated regression results, real-device and owner gates kept separate |

Each definition includes exact ownership and failure cases. All workers may read the relevant code; only the assigned worker writes its paths. The lead owns `engine.py`, `server.py`, the Swift adapter, public contracts and integration. Nobody edits the protected native library, old web app, deployment configuration or historical workflows. Workers must request shared-file changes from the lead.

## Execution order

**Wave 1:** launch editor, audio and mobile. Give each a bounded implementation task, test requirement and common baseline. Ask for runnable patches, not just recommendations. Worktree isolation is preferable; if workers share a filesystem, honor the disjoint path leases strictly. No worker commits or pushes while another owns integration.

**Wave 2:** release completed workers; launch picture and the independent QA reviewer. QA can examine the unchanged baseline and completed diffs while other work finishes. The lead reviews interfaces and integrates only tested changes, preserving a way to compare with the original behavior. Experimental output treatments stay opt-in until quality evidence supports making them default. No extra workers or recursive delegation.

**Wave 3:** stop implementation churn. The lead runs one full generated-media suite at a time, then QA reviews the exact integrated commit. Serialize Swift builds and full FFmpeg tests to avoid memory contention. Resolve concrete blockers in at most two bounded correction rounds; report unresolved items instead of looping indefinitely. Do not remove assertions or redefine success to get a green check.

Use the existing package and renderer. New scoped modules must be called by the existing pipeline after integration; unconnected code is not a finished feature. Native installation is not part of this sprint and remains unresolved under the current setup.

## First failures worth investigating

The UI needs to preserve visible settings, not only moments, on refresh. Prompt interpretation must not silently override a user's later manual choices. Media selection must distinguish explicit include-all intent from a short automatically selected trailer. Inspect and reproduce these in the current code before deciding on a patch.

A finished Linux render currently deletes uploaded sources, so it cannot support another edit without reimporting. Do not silently change that privacy promise. A future draft-review cycle requires a visible opt-in retention choice, expiry, deletion tests and an owner-understandable distinction between draft preview and final export. Plan this contract with the lead rather than having several workers change retention independently.

The current soundtrack processing is not crowd-vocal isolation, and picture heuristics are not artist recognition. Improve what is measurable and label what remains experimental. A library download or model choice alone is not evidence of better footage.

## What makes further investment reasonable

The following are separate gates, not one automated test count:

- **Technical:** integrated regression tests pass; complete 9:16 H.264/AAC output, correct duration and sound timing; cancellation, access controls and media deletion pass.
- **Editorial:** baseline and candidate use the same approved moments/settings where applicable, and each intentional difference is documented. No arbitrary punch-ins, filler loops, overused effects, or hiding omitted sources.
- **Human and device:** the owner completes Photos upload, review, full playback, save and replay with sound on the actual iPhone. Then the owner answers: *Does this capture the night? Would I share it?* Until those answers exist, creative value remains unverified.
- **Operations:** measured processing time, peak memory, temporary disk use and output size, plus a source-backed conservative cost estimate and proposed spending cap. Do not provision a host to obtain a quote. Development Codespaces are not a production hosting plan.
- **Independent review:** the QA task reviews the exact integrated revision and reports unresolved findings separately from the implementing workers.

`quality_gate.py` checks whether a completed evidence packet is internally consistent. It cannot authenticate task IDs, independently inspect referenced logs, judge artistic quality or authorize money. Even a complete packet means **ready for the owner's investment review**, not permission to pay or launch.

Real-footage evaluation requires explicit owner-supplied or authorized clips in the permitted private environment. Never commit them, attach them to public issues, or upload them to Actions/artifacts. Synthetic tests cannot stand in for this approval. No Codespace creation until remaining included usage and a no-paid-overage boundary are verified. Continue independent code work without turning that unresolved access check into another setup assignment for the owner.

## Return to the owner

One short `Project feedback:`, `Test:` or `Login:` message. State actual agents launched versus merely prepared, the integrated result, evidence, and the single remaining action. Do not promise same-day release, virality, background work beyond an actual job, or untested device support. The owner should test a result, not debug the development stack.

## References checked for setup

- Custom subagent configuration and runtime limitations: https://developers.openai.com/codex/subagents
- Cloud tasks and published environments: https://developers.openai.com/codex/cloud
- Plan access and usage limits: https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan

The role files inherit the authorized parent model and permissions. `.codex/config.toml` only caps concurrency; it does not enable disabled tools or guarantee available allowance. No Claude session is connected or launched by these files.
