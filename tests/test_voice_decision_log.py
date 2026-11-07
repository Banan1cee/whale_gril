import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'bridge'))
from voice_reply import choose


class VoiceDecisionLogTest(unittest.TestCase):
    def test_reasons_and_single_random_draw(self):
        logs, draws = [], []
        def rng():
            draws.append(1)
            return 0.9
        self.assertFalse(choose({}, 'private content', False, rng, log=logs.append))
        self.assertIn('reason=disabled', logs[-1])
        self.assertFalse(choose({'Enabled': True, 'Private': False}, '', False, rng, log=logs.append))
        self.assertIn('reason=chat_type_disabled', logs[-1])
        self.assertFalse(choose({'Enabled': True}, '只用文字回复', False, rng, log=logs.append))
        self.assertIn('reason=user_requested_text', logs[-1])
        self.assertFalse(choose({'Enabled': True, 'Probability': 25}, 'private content', False, rng, log=logs.append))
        self.assertIn('reason=probability_miss', logs[-1])
        self.assertEqual(len(draws), 1)
        self.assertNotIn('private content', str(logs))

    def test_logger_failure_does_not_change_decision(self):
        def broken(_):
            raise RuntimeError('logger')
        self.assertTrue(choose({'Enabled': True, 'Probability': 100}, '', False, lambda: 0, log=broken))


if __name__ == '__main__':
    unittest.main()
