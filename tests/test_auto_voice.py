import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('voice_reply', ROOT / 'bridge' / 'voice_reply.py')
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)

class PolicyTests(unittest.TestCase):
    def test_off_does_not_create_job_or_start_worker(self):
        with tempfile.TemporaryDirectory() as root:
            with patch.object(v.subprocess, 'Popen') as start:
                self.assertFalse(v.deliver(root, '发语音', 1, lambda: '群', lambda *a: None))
                start.assert_not_called()
            self.assertFalse((Path(root) / 'data' / 'voice-send-jobs').exists())
    def test_explicit_requests(self):
        for text in ('发一条语音听听', '给我发条语音', '用语音回复我', '来一段语音', '鲸鲸，说句语音'):
            self.assertTrue(v.requested(text), text)
    def test_negatives_and_discussion(self):
        for text in ('不要发语音', '别发语音了', '怎么发语音', '他说发一条语音听听', '“发条语音”是什么意思', '今天吃什么'):
            self.assertFalse(v.requested(text), text)
    def test_probability_and_one_shot_override(self):
        c = {'Enabled': True, 'Probability': 25}
        self.assertTrue(v.choose(c, '你好', False, lambda: .249))
        self.assertFalse(v.choose(c, '你好', True, lambda: .25))
        c['Probability'] = 0
        self.assertTrue(v.choose(c, '发条语音听听', True, lambda: 1))
        self.assertFalse(v.choose(c, '接下来呢', True, lambda: 0))
    def test_off_and_chat_scope_override_explicit_request(self):
        for c in ({'Enabled': False}, {'Enabled': 'true'}, {'Enabled': True, 'Groups': False}):
            self.assertFalse(v.choose(c, '发条语音', True, lambda: 0))
        self.assertFalse(v.choose({'Enabled': True, 'Private': False}, '发条语音', False, lambda: 0))
    def test_invalid_probability_fails_closed(self):
        for chance in (None, 'bad', float('nan'), float('inf'), -1, 101):
            self.assertFalse(v.choose({'Enabled': True, 'Probability': chance}, '你好', False, lambda: 0))
    def test_text_request_overrides_even_hundred_percent_voice(self):
        for text in ('不要发语音', '别再发语音了', '用文字回复我', '文本回复'):
            self.assertFalse(v.choose({'Enabled': True, 'Probability': 100}, text, False, lambda: 0))
    def test_delivery_never_repeats_uncertain_voice(self):
        for status, handled in [('sent_unconfirmed', True), ('uncertain', True), ('failed', False)]:
            with self.subTest(status=status), tempfile.TemporaryDirectory() as root:
                data = Path(root) / 'data'; data.mkdir()
                (data / 'voice-send.json').write_text('{"Enabled":true}')
                class Process:
                    pid = 1
                    done = False
                    def __init__(self, args, **kwargs):
                        self.path = args[-1]
                        Path(self.path + '.ready').write_text('ready')
                    def poll(self): return 0 if self.done else None
                    def wait(self, **kwargs):
                        self.done = True
                        Path(self.path + '.result').write_text(json.dumps({'Status': status}))
                        return 0
                with patch.object(v.subprocess, 'Popen', Process):
                    self.assertEqual(v.deliver(root, '模型原始回复', 1, lambda: '测试群', lambda *a: None, allow_foreground=lambda pid: None), handled)
                self.assertEqual(list((data / 'voice-send-jobs').iterdir()), [])
    def test_prepare_failure_falls_back_before_recording(self):
        with tempfile.TemporaryDirectory() as root:
            data = Path(root) / 'data'; data.mkdir(); (data / 'voice-send.json').write_text('{"Enabled":true}')
            class Process:
                pid = 1
                def __init__(self, args, **kwargs): Path(args[-1] + '.ready').write_text('ready')
                def poll(self): return None
                def wait(self, **kwargs): return 0
            with patch.object(v.subprocess, 'Popen', Process):
                self.assertFalse(v.deliver(root, '同一回复', 1, lambda: '', lambda *a: None))

    def test_cancelled_test_never_starts_worker(self):
        with tempfile.TemporaryDirectory() as root:
            data = Path(root) / 'data'; data.mkdir(); (data / 'voice-send.json').write_text('{"Enabled":true}')
            outcome = {}
            with patch.object(v.subprocess, 'Popen') as start:
                self.assertFalse(v.deliver(root, '测试', 1, lambda: '文件传输助手', lambda *a: None,
                                           cancelled=lambda: True, outcome=outcome))
                start.assert_not_called()
            self.assertEqual(outcome['Status'], 'failed')

    def test_delivery_reports_worker_error_to_test_ui(self):
        with tempfile.TemporaryDirectory() as root:
            data = Path(root) / 'data'; data.mkdir(); (data / 'voice-send.json').write_text('{"Enabled":true}')
            class Process:
                pid = 1
                def __init__(self, args, **kwargs):
                    Path(args[-1] + '.result').write_text(json.dumps({'Status': 'failed', 'Error': 'HTTP 401'}))
                def poll(self): return 2
                def wait(self, **kwargs): return 2
            outcome = {}
            with patch.object(v.subprocess, 'Popen', Process):
                self.assertFalse(v.deliver(root, '测试', 1, lambda: '文件传输助手', lambda *a: None, outcome=outcome))
            self.assertEqual(outcome, {'Status': 'failed', 'Error': 'HTTP 401'})

if __name__ == '__main__': unittest.main()
