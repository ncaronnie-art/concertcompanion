"""Fail-closed evidence checklist. Does not launch agents, verify claims, or spend.

Keep completed packets outside the public repository. Evidence references must
be reviewed by a human or an independently running reviewer, not trusted solely
because this structural validator accepts them.
"""
from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

ROLES = ('cc_editor', 'cc_audio', 'cc_picture', 'cc_mobile', 'cc_qa')
GATES = ('regression', 'editorial', 'audio', 'picture', 'browser', 'iphone',
         'owner', 'operating_cost', 'independent_review')
PHONE_STEPS = ('upload_from_photos', 'review', 'complete_playback', 'sound_in_sync',
               'save_to_photos', 'photos_replay_with_sound', 'test_media_deleted')
SHA = re.compile(r'^[0-9a-f]{40}$')


def evaluate(packet: dict[str, Any]) -> dict[str, Any]:
    """Return unmet gates; never turn a checklist into payment authorization."""
    if not isinstance(packet, dict):
        raise ValueError('The evidence packet must be a JSON object.')
    blockers: list[str] = []
    commit = packet.get('candidate_commit')
    if not isinstance(commit, str) or not SHA.fullmatch(commit):
        blockers.append('candidate_commit: full tested Git revision is missing')
    runs = packet.get('agent_runs', [])
    if not isinstance(runs, list) or any(not isinstance(r, dict) for r in runs):
        raise ValueError('agent_runs must be a list of objects.')
    ids: list[str] = []
    for role in ROLES:
        matches = [r for r in runs if r.get('role') == role]
        if len(matches) != 1:
            blockers.append(f'{role}: exactly one actual completed task receipt required')
            continue
        run = matches[0]
        task = run.get('task_id')
        if (not isinstance(task, str) or not task.strip()
                or task.lower() in ('todo', 'not_started', 'pending', 'example')
                or run.get('status') != 'completed'
                or not isinstance(run.get('evidence'), str) or not run['evidence'].strip()):
            blockers.append(f'{role}: runtime task ID, completion and evidence required')
        elif task in ids:
            blockers.append(f'{role}: reused task ID is not independent execution evidence')
        else:
            ids.append(task)
    gates = packet.get('gates', {})
    if not isinstance(gates, dict):
        raise ValueError('gates must be an object.')
    for name in GATES:
        gate = gates.get(name, {})
        if not isinstance(gate, dict):
            raise ValueError(f'{name} must be an object.')
        evidence = gate.get('evidence', [])
        if (gate.get('status') != 'pass' or gate.get('tested_commit') != commit
                or not isinstance(evidence, list) or not evidence
                or not all(isinstance(e, str) and e.strip() for e in evidence)):
            blockers.append(f'{name}: passing evidence for the exact candidate is missing')
    phone = gates.get('iphone', {})
    if phone.get('device') != 'physical_iphone':
        blockers.append('iphone: simulation, bridge and desktop viewport are not a physical iPhone')
    observations = phone.get('observed_steps', {})
    if not isinstance(observations, dict) or any(observations.get(k) is not True for k in PHONE_STEPS):
        blockers.append('iphone: the complete phone round trip and cleanup are unverified')
    owner = gates.get('owner', {})
    if owner.get('captures_night') is not True or owner.get('would_share') is not True:
        blockers.append('owner: actual positive creative feedback is missing')
    if owner.get('baseline_comparison') != 'candidate_preferred':
        blockers.append('owner: candidate has not earned preference over the baseline')
    cost = gates.get('operating_cost', {})
    if cost.get('measured_resources') is not True or cost.get('current_rate_sources') is not True:
        blockers.append('operating_cost: measurements and current sourced rates are missing')
    review = gates.get('independent_review', {})
    if review.get('reviewer_role') != 'cc_qa' or review.get('unresolved_release_blockers') != []:
        blockers.append('independent_review: independent approval or resolved blockers missing')
    return {
        'ready_for_owner_investment_review': not blockers,
        'spending_authorized': False,
        'deployment_authorized': False,
        'evidence_contents_verified_by_this_script': False,
        'blockers': blockers,
    }


def template() -> dict[str, Any]:
    return {
        'schema_version': 1, 'candidate_commit': None, 'agent_runs': [],
        'gates': {name: {'status': 'not_run', 'tested_commit': None, 'evidence': []} for name in GATES},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('packet', nargs='?', type=Path)
    parser.add_argument('--template', action='store_true')
    args = parser.parse_args()
    if args.template:
        print(json.dumps(template(), indent=2))
        return 0
    if args.packet is None:
        parser.error('Pass a local evidence packet or --template.')
    try:
        if args.packet.stat().st_size > 1_048_576:
            raise ValueError('Evidence packet is too large; reference logs rather than embedding them.')
        report = evaluate(json.loads(args.packet.read_text()))
    except (OSError, ValueError, TypeError) as exc:
        parser.exit(2, f'Invalid evidence packet: {exc}\n')
    print(json.dumps(report, indent=2))
    return 0 if report['ready_for_owner_investment_review'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
