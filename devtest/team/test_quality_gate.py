"""Checklist tests only; fixtures below are fictional, not execution receipts."""
import copy
import unittest
from quality_gate import GATES, PHONE_STEPS, ROLES, evaluate, template


def complete_example():
    commit = 'a' * 40
    packet = {'candidate_commit': commit,
              'agent_runs': [{'role': role, 'task_id': f'test-fixture-{i}',
                              'status': 'completed', 'evidence': 'test-only:receipt'}
                             for i, role in enumerate(ROLES)],
              'gates': {g: {'status': 'pass', 'tested_commit': commit,
                            'evidence': ['test-only:evidence']} for g in GATES}}
    packet['gates']['iphone'].update(device='physical_iphone', observed_steps=dict.fromkeys(PHONE_STEPS, True))
    packet['gates']['owner'].update(captures_night=True, would_share=True, baseline_comparison='candidate_preferred')
    packet['gates']['operating_cost'].update(measured_resources=True, current_rate_sources=True)
    packet['gates']['independent_review'].update(reviewer_role='cc_qa', unresolved_release_blockers=[])
    return packet


class QualityGateTests(unittest.TestCase):
    def test_untested_template_cannot_pass(self):
        self.assertFalse(evaluate(template())['ready_for_owner_investment_review'])

    def test_complete_fixture_is_not_payment_or_claim_verification(self):
        result = evaluate(complete_example())
        self.assertTrue(result['ready_for_owner_investment_review'])
        for key in ('spending_authorized', 'deployment_authorized', 'evidence_contents_verified_by_this_script'):
            self.assertIs(result[key], False)

    def test_pass_word_without_evidence_cannot_pass(self):
        p = complete_example(); p['gates']['audio']['evidence'] = []
        self.assertFalse(evaluate(p)['ready_for_owner_investment_review'])

    def test_wrong_commit_cannot_pass(self):
        p = complete_example(); p['gates']['regression']['tested_commit'] = 'b' * 40
        self.assertFalse(evaluate(p)['ready_for_owner_investment_review'])

    def test_viewport_is_not_phone(self):
        p = complete_example(); p['gates']['iphone']['device'] = 'mobile_viewport'
        self.assertFalse(evaluate(p)['ready_for_owner_investment_review'])

    def test_missing_photos_sound_step_cannot_pass(self):
        p = complete_example(); del p['gates']['iphone']['observed_steps']['photos_replay_with_sound']
        self.assertFalse(evaluate(p)['ready_for_owner_investment_review'])

    def test_owner_no_or_not_asked_cannot_pass(self):
        for value in (None, False, 'true', 1):
            p = complete_example(); p['gates']['owner']['would_share'] = value
            self.assertFalse(evaluate(p)['ready_for_owner_investment_review'])

    def test_repeated_task_is_not_separate_agents(self):
        p = complete_example(); p['agent_runs'][1]['task_id'] = p['agent_runs'][0]['task_id']
        self.assertFalse(evaluate(p)['ready_for_owner_investment_review'])

    def test_prepared_role_is_not_running(self):
        p = complete_example(); p['agent_runs'][0]['status'] = 'prepared'
        self.assertFalse(evaluate(p)['ready_for_owner_investment_review'])

    def test_pricing_without_measurement_fails(self):
        p = complete_example(); p['gates']['operating_cost']['measured_resources'] = False
        self.assertFalse(evaluate(p)['ready_for_owner_investment_review'])

    def test_open_release_blocker_fails(self):
        p = complete_example(); p['gates']['independent_review']['unresolved_release_blockers'] = ['audio dropped']
        self.assertFalse(evaluate(p)['ready_for_owner_investment_review'])

    def test_malformed_collections_are_rejected(self):
        for p in ([], {'agent_runs': 'not-a-list'}, {'gates': []}, {'gates': {'audio': None}}):
            with self.assertRaises(ValueError): evaluate(p)

    def test_does_not_modify_input(self):
        p = complete_example(); original = copy.deepcopy(p)
        evaluate(p)
        self.assertEqual(p, original)


if __name__ == '__main__':
    unittest.main(verbosity=2)
