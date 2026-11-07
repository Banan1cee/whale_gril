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

sys.path.insert(0, str(Path(__file__).resolve().parent))
SOURCE = Path(os.environ.get('WHALE_TEST_ENGINE_SOURCE') or Path(__file__).resolve().parents[1] / 'bridge/engine.py')
TREE = ast.parse(SOURCE.read_text(encoding='utf-8-sig'))
CONFIG_SOURCE = SOURCE.parent / 'config.py'
CONFIG_TREE = ast.parse(CONFIG_SOURCE.read_text(encoding='utf-8-sig'))
VOICE_SOURCE = SOURCE.parent / 'voice.py'
VOICE_TREE = ast.parse(VOICE_SOURCE.read_text(encoding='utf-8-sig'))

from bridge_ast import load_function  # noqa: E402


def function(name, env):
    return load_function(name, env)

def config_function(name, env):
    node = next(n for n in ast.walk(CONFIG_TREE) if isinstance(n, ast.FunctionDef) and n.name == name)
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(CONFIG_SOURCE), 'exec'), env)
    return env[name]

def voice_function(name, env):
    node = next(n for n in ast.walk(VOICE_TREE) if isinstance(n, ast.FunctionDef) and n.name == name)
    exec(compile(ast.Module(body=[node], type_ignores=[]), str(VOICE_SOURCE), 'exec'), env)
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
            voice_reply=types.SimpleNamespace(settings=lambda *a: {}, choose=lambda *a, **k: False), ROOT='test', random=types.SimpleNamespace(random=lambda: .5),
            ONLY_CHATS=[], aliases=['鲸鲸'], _GROUP_SENDER_PREFIX_RE=re.compile(r'^wxid_x:\s*'),
            log=lambda *a: logs.append(a), log_throttled=lambda *a, **k: logs.append(a),
            db=types.SimpleNamespace(get_nickname=lambda s: '好友'), display_name=lambda s: '好友',
            is_system_notice=lambda *a: False, duplicate_guard=lambda *a: False,
            LOCAL_HTTP=http, token='test', bot_url='http://localhost/webhook/wechat',
            CONN_STATE={}, MOCK_NOTICED={'done': False}, QUOTE_REPLY=False,
            rate_guard=lambda *a: True, send_at=lambda *a: False,
            send_text=lambda text, *a, **k: sent.append(text) or send_ok,
            STICKER_TEST_ON=True, claim_and_send_sticker=lambda *a, **k: stickers.append(a))
        # 0eba2cb 之后 on_message_inner 会调用模块级 fix_garbled；单函数抽取要把它一起带上
        env['fix_garbled'] = function('fix_garbled', env)
        # 0eba2cb 之后 on_message_inner 会调用模块级 fix_garbled；单函数抽取要把它一起带上
        env['fix_garbled'] = function('fix_garbled', env)
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

    def test_garbled_gbk_text_is_restored_before_sending(self):
        # 0eba2cb：微信有的版本把正文按 GBK 存、却被当 Latin-1 读出来，
        # 用户看到的是「ÏÂÎçºÃÑ½」。修好以后正常文本原样返回，乱码还原成中文。
        env, _, sent, _, _ = self.env()
        fix = function('fix_garbled', env)
        raw = '下午好呀'.encode('gbk').decode('latin-1')
        self.assertEqual(fix(raw), '下午好呀')
        self.assertEqual(fix('正常的中文'), '正常的中文')
        self.assertEqual(fix(''), '')
        self.assertEqual(fix(None), None)
        self.assertEqual(fix('hello world'), 'hello world')
    def test_garbled_gbk_text_is_restored_before_sending(self):
        # 0eba2cb：微信有的版本把正文按 GBK 存、却被当 Latin-1 读出来，
        # 用户看到的是「ÏÂÎçºÃÑ½」。修好以后正常文本原样返回，乱码还原成中文。
        env, _, sent, _, _ = self.env()
        fix = function('fix_garbled', env)
        raw = '下午好呀'.encode('gbk').decode('latin-1')
        self.assertEqual(fix(raw), '下午好呀')
        self.assertEqual(fix('正常的中文'), '正常的中文')
        self.assertEqual(fix(''), '')
        self.assertEqual(fix(None), None)
        self.assertEqual(fix('hello world'), 'hello world')
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

    def test_explicit_sticker_skips_background_text_and_voice(self):
        item = {'id': 'test'}
        env, _, sent, stickers, _ = self.env(Response({
            'ok': True, 'action': 'reply', 'reply': '给你挑了一张',
            'stickerOnly': True, 'sticker': item,
        }))
        env['voice_reply'].choose = lambda *a: self.fail('explicit sticker cannot choose voice')
        function('on_message_inner', env)(self.message(), None)
        self.assertEqual(sent, [])
        self.assertEqual(stickers, [(item,)])

    def test_voice_replaces_all_text_bubbles_with_the_same_reply(self):
        env, _, sent, stickers, _ = self.env(Response({'ok': True, 'action': 'reply', 'reply': '模型回复', 'bubbles': ['第一句', '第二句']}))
        captured=[]
        env['voice_reply'].choose=lambda *a, **k: True
        env['send_voice_reply']=lambda text, *a: captured.append(text) or True
        function('on_message_inner',env)(self.message(),None)
        self.assertEqual(captured,['第一句\n第二句'])
        self.assertEqual(sent,[]);self.assertEqual(stickers,[])

    def test_voice_failure_before_recording_keeps_original_text(self):
        env, _, sent, _, _ = self.env(Response({'ok': True, 'action': 'reply', 'reply': '原始回复', 'bubbles': ['原始回复']}))
        env['voice_reply'].choose=lambda *a, **k: True
        env['send_voice_reply']=lambda *a: False
        function('on_message_inner',env)(self.message(),None)
        self.assertEqual(sent,['原始回复'])

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
            self.assertTrue(config_function('wait_for_server', env)('http://localhost/webhook/wechat', timeout=5))
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
        from urllib.parse import urlsplit
        with tempfile.TemporaryDirectory() as root:
            (Path(root)/'data').mkdir()
            (Path(root)/'data/settings.json').write_text(json.dumps(settings), encoding='utf-8')
            fn = voice_function('resolve_voice_key', dict(os=os, json=json, urlsplit=urlsplit))
            return fn(cfg, 'https://dashscope.aliyuncs.com/api/v1/asr', root)
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
