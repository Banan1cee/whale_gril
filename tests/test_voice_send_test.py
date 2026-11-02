import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'bridge'))
import voice_send_test as v


class TestQueue(unittest.TestCase):
    def request(self, root, *, enabled=True, age=0, extra=None):
        data = Path(root) / 'data'
        directory = data / 'voice-send-tests'
        directory.mkdir(parents=True, exist_ok=True)
        (data / 'voice-send.json').write_text(json.dumps({'Enabled': enabled}), encoding='utf-8')
        value = {'CreatedAt': time.time() * 1000 - age}
        value.update(extra or {})
        path = directory / ('a' * 32)
        path.with_suffix('.json').write_text(json.dumps(value), encoding='utf-8')
        return path

    def test_disabled_and_stale_requests_never_send(self):
        for enabled, age in [(False, 0), (True, 31000), (True, -60000)]:
            with self.subTest(enabled=enabled, age=age), tempfile.TemporaryDirectory() as root:
                path = self.request(root, enabled=enabled, age=age)
                send = Mock()
                v.process_pending(root, send)
                send.assert_not_called()
                self.assertEqual(json.loads(path.with_suffix('.result').read_text(encoding='utf-8'))['Status'], 'failed')

    def test_exact_text_target_and_no_replay(self):
        with tempfile.TemporaryDirectory() as root:
            path = self.request(root, extra={'Text': '不要发送这个', 'Target': '另一个人'})
            def send(text, who, username, *, cancelled, outcome):
                self.assertEqual((text, who, username), ('哈喽哈喽，可以听见我说话么', '文件传输助手', 'filehelper'))
                self.assertFalse(cancelled())
                outcome.update(Status='sent_unconfirmed', Error='')
            sender = Mock(side_effect=send)
            v.process_pending(root, sender)
            v.process_pending(root, sender)
            self.assertEqual(sender.call_count, 1)
            self.assertEqual(json.loads(path.with_suffix('.result').read_text(encoding='utf-8'))['Status'], 'sent_unconfirmed')

    def test_cancel_and_invalid_requests_never_send(self):
        with tempfile.TemporaryDirectory() as root:
            path = self.request(root)
            path.with_suffix('.cancel').write_text('cancel')
            sender = Mock()
            v.process_pending(root, sender)
            sender.assert_not_called()
            path = self.request(root, extra={'CreatedAt': 'invalid'})
            v.process_pending(root, sender)
            sender.assert_not_called()

    def test_switch_off_while_waiting_for_send_lock_is_observable(self):
        with tempfile.TemporaryDirectory() as root:
            path = self.request(root)
            def send(*args, cancelled, outcome):
                (Path(root) / 'data' / 'voice-send.json').write_text('{"Enabled":false}')
                self.assertTrue(cancelled())
            v.process_pending(root, send)
            self.assertEqual(json.loads(path.with_suffix('.result').read_text(encoding='utf-8'))['Status'], 'failed')


if __name__ == '__main__':
    unittest.main()
