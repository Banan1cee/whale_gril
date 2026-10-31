import ast
import os
import re
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

SOURCE = Path(os.environ.get('WHALE_TEST_ENGINE_SOURCE') or Path(__file__).resolve().parents[1] / 'bridge/engine.py')
TREE = ast.parse(SOURCE.read_text(encoding='utf-8-sig'))

def function(name, env):
    node = next(n for n in ast.walk(TREE) if isinstance(n, ast.FunctionDef) and n.name == name)
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(SOURCE), 'exec'), env)
    return env[name]

class Response:
    def __init__(self, body, status=200): self.body, self.status_code = body, status
    def json(self): return self.body

class BridgeUserFlows(unittest.TestCase):
    def env(self, response=None, send_ok=True):
        sent, stickers, logs = [], [], []
        clock = types.SimpleNamespace(now=200.)
        clock.time = lambda: clock.now
        clock.sleep = lambda *_: None
        http = types.SimpleNamespace(post=lambda *a, **k: response or Response({'ok': True, 'action': 'reply', 'reply': '回答', 'bubbles': ['回答'], 'sticker': {'id': 'test'}}))
        env = dict(time=clock, me='self', START_TS=100., SKIP_OLDER_THAN=10, STALE_AFTER=4.,
            ONLY_CHATS=[], aliases=['鲸鲸'], _GROUP_SENDER_PREFIX_RE=re.compile(r'^wxid_x:\s*'),
            log=lambda *a: logs.append(a), log_throttled=lambda *a, **k: logs.append(a),
            db=types.SimpleNamespace(get_nickname=lambda s: '好友'), display_name=lambda s: '好友',
            is_system_notice=lambda *a: False, duplicate_guard=lambda *a: False,
            LOCAL_HTTP=http, token='test', bot_url='http://localhost/webhook/wechat',
            CONN_STATE={}, MOCK_NOTICED={'done': False}, QUOTE_REPLY=False,
            rate_guard=lambda *a: True, send_at=lambda *a: False,
            send_text=lambda text, *a, **k: sent.append(text) or send_ok,
            STICKER_TEST_ON=True, claim_and_send_sticker=lambda *a, **k: stickers.append(a))
        return env, clock, sent, stickers, logs

    def message(self, **changes):
        return dict(username='peer', sender_username='friend', type='文本', content='问题', create_time=200., local_id=1, **changes)

    def test_slow_image_recognition_does_not_make_fresh_message_stale(self):
        env, clock, sent, _, _ = self.env()
        def recognize(msg): clock.now += 30; return '识别出的文字'
        env['describe_image'] = recognize
        msg = self.message(); msg['type'] = '图片'
        function('on_message_inner', env)(msg, None)
        self.assertEqual(sent, ['回答'])

    def test_queue_wait_does_not_discard_message_received_in_time(self):
        env, clock, sent, _, _ = self.env()
        msg = self.message(); msg['create_time'] = 120.; msg['_bridge_received_at'] = 121.
        function('on_message_inner', env)(msg, None)
        self.assertEqual(sent, ['回答'])

    def test_truly_old_message_is_rejected_before_image_work(self):
        env, _, sent, _, _ = self.env()
        recognized = []
        env['describe_image'] = lambda msg: recognized.append(msg) or '识别结果'
        msg = self.message(); msg['type'] = '图片'; msg['create_time'] = 180.
        queued = []
        env['batches'] = types.SimpleNamespace(push=lambda *args: queued.append(args) or False)
        function('on_message', env)(msg, None)
        self.assertEqual(queued, []); self.assertEqual(recognized, [])

    def test_own_image_is_not_sent_to_vision(self):
        env, _, sent, _, _ = self.env()
        recognized = []
        env['describe_image'] = lambda msg: recognized.append(msg) or '识别结果'
        msg = self.message(); msg['type'] = '图片'; msg['sender_username'] = 'self'
        function('on_message_inner', env)(msg, None)
        self.assertEqual(sent, []); self.assertEqual(recognized, [])

    def test_string_bubbles_are_not_sent_one_character_at_a_time(self):
        env, _, sent, _, _ = self.env(Response({'ok': True, 'action': 'reply', 'reply': '整句回答', 'bubbles': '整句回答'}))
        function('on_message_inner', env)(self.message(), None)
        self.assertEqual(sent, ['整句回答'])

    def test_failed_text_send_stops_remaining_bubbles_and_sticker(self):
        env, _, sent, stickers, _ = self.env(Response({'ok': True, 'action': 'reply', 'reply': '回答', 'bubbles': ['第一句', '第二句'], 'sticker': {'id': 'test'}}), send_ok=False)
        function('on_message_inner', env)(self.message(), None)
        self.assertEqual(sent, ['第一句']); self.assertEqual(stickers, [])

    def test_auth_failure_is_not_reported_as_successful_connection(self):
        env, _, sent, _, logs = self.env(Response({'ok': False, 'error': 'token'}, 403))
        function('on_message_inner', env)(self.message(), None)
        self.assertFalse(env['CONN_STATE']['ok']); self.assertEqual(sent, [])
        self.assertTrue(any('token' in str(row) for row in logs))

    def test_wrong_service_or_404_does_not_pass_readiness_check(self):
        clock = [100.]; responses = iter([Response({}, 404), Response({'ok': True, 'up': True}), Response({'ok': True, 'up': True, 'service': 'whale-girl'})])
        requests = []
        def get(*args, **kw): requests.append(args); return next(responses)
        env = dict(LOCAL_HTTP=types.SimpleNamespace(get=get), log=lambda *a: None)
        with patch('time.time', side_effect=lambda: clock[0]), patch('time.sleep', side_effect=lambda seconds: clock.__setitem__(0, clock[0]+seconds)):
            self.assertTrue(function('wait_for_server', env)('http://localhost/webhook/wechat', timeout=5))
        self.assertEqual(len(requests), 3)

    def test_long_png_segments_are_labelled_as_jpeg(self):
        class Image:
            size = (1000, 3000)
            def load(self): pass
            def crop(self, box): return self
            def convert(self, mode): return self
            def save(self, output, **kw): output.write(b'\xff\xd8\xfftest')
        calls = []
        with tempfile.TemporaryDirectory() as folder:
            image = Path(folder)/'long.png'; image.write_bytes(b'\x89PNG\r\n\x1a\n' + b'fake')
            env = dict(os=os, bot_url='http://localhost/webhook/wechat', log=lambda *a: None, log_throttled=lambda *a: None,
                _get_media=lambda: types.SimpleNamespace(download_image=lambda *a, **k: str(image)),
                LOCAL_HTTP=types.SimpleNamespace(post=lambda *a, **kw: calls.append(kw['json']) or Response({'ok':True,'text':'OCR'})))
            with patch.dict(sys.modules, {'PIL': types.SimpleNamespace(Image=types.SimpleNamespace(open=lambda *a: Image()))}):
                self.assertTrue(function('describe_image', env)({'username':'peer','local_id':1}))
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(call['mime']=='image/jpeg' for call in calls))


class VoiceKeyIsolation(unittest.TestCase):
    def resolve(self, cfg, settings):
        import json
        with tempfile.TemporaryDirectory() as root:
            (Path(root)/'data').mkdir()
            (Path(root)/'data/settings.json').write_text(json.dumps(settings), encoding='utf-8')
            return function('_resolve_voice_key', dict(ROOT=root, os=os, json=json, VOICE_BASE_URL='https://dashscope.aliyuncs.com/api/v1/asr'))(cfg)
    def test_default_asr_does_not_receive_deepseek_chat_key(self):
        self.assertEqual(self.resolve({'deepseek':{'apiKey':'chat-only'}}, {'provider':'deepseek','apiKey':'chat-only'}), '')
    def test_qwen_key_is_selected_instead_of_vision_key(self):
        self.assertEqual(self.resolve({}, {'keys':{'vision':'wrong-vision','qwen':'right-qwen'}}), 'right-qwen')
    def test_explicit_voice_key_remains_supported(self):
        self.assertEqual(self.resolve({'voice':{'apiKey':'voice-only'}}, {'apiKey':'chat-only'}), 'voice-only')
    def test_custom_endpoint_only_reuses_key_from_same_origin(self):
        cfg={'voice':{'baseUrl':'https://asr.example/api/asr'}}
        self.assertEqual(self.resolve(cfg, {'baseUrl':'https://chat.example/v1','apiKey':'other-host'}), '')
        self.assertEqual(self.resolve(cfg, {'baseUrl':'https://asr.example/v1','apiKey':'same-host'}), 'same-host')

if __name__ == '__main__': unittest.main()
