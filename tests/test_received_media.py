import ast
import hashlib
import io
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
import uuid
from unittest.mock import Mock

try:
    from PIL import Image
except ImportError:  # 干净的 Python / 没装 Pillow：整组跳过，别让一堆无关用例跟着红
    raise unittest.SkipTest('表情包解码要 Pillow（随包 runtime 自带；源码环境 pip install pillow）')

try:  # AES 回源解密那条用例才需要它
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes  # noqa: F401
    HAS_CRYPTO = True
except ImportError:
    HAS_CRYPTO = False

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tests'))
sys.path.insert(0, str(ROOT / 'bridge'))
import emoji_vision
from image_cache import bind_target_probe, V2_MAGIC


from bridge_ast import load_function  # noqa: E402


def nested(name, env):
    return load_function(name, env)


class ReceivedMediaTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.image = self.root / 'image.png'
        Image.new('RGB', (40, 30), 'blue').save(self.image)

    def env(self, download):
        post = Mock(return_value=types.SimpleNamespace(json=lambda: {'ok': True, 'text': '蓝色图片'}))
        sleeps = []
        env = dict(os=os, time=types.SimpleNamespace(sleep=sleeps.append),
                   bot_url='http://localhost/webhook/wechat', log=Mock(), log_throttled=Mock(),
                   _get_media=lambda: types.SimpleNamespace(download_image=download),
                   LOCAL_HTTP=types.SimpleNamespace(post=post))
        return env, post, sleeps

    def test_image_waits_for_cache_and_keeps_message_shard(self):
        download = Mock(side_effect=[None, None, str(self.image)])
        env, post, sleeps = self.env(download)
        result = nested('describe_image', env)({'username': 'peer', 'local_id': 4, 'shard': 'shard2'})
        self.assertEqual(result, '蓝色图片')
        self.assertEqual(sleeps, [0.5])
        self.assertEqual(len(post.call_args_list), 1)
        self.assertTrue(all(call.kwargs['shard'] == 'shard2' for call in download.call_args_list))

    def test_image_unavailable_stops_without_vision_request(self):
        download = Mock(return_value=None)
        env, post, sleeps = self.env(download)
        self.assertEqual(nested('describe_image', env)({'username': 'peer', 'local_id': 4}), '')
        self.assertEqual(download.call_count, 8)
        self.assertEqual(sleeps, [0.5, 1, 2])
        post.assert_not_called()

    def test_decryption_validates_current_image_instead_of_old_probe(self):
        target = self.root / 'target.dat'
        probe = b'current-probe-16'
        probe = probe.ljust(16, b'!')
        target.write_bytes(V2_MAGIC + b'\0' * 9 + probe + b'\0')
        downloader = types.SimpleNamespace(_key_probe=b'old', _xor_key=123)
        observed = []
        downloader.decrypt_image = lambda path, **kw: observed.append((downloader._key_probe, downloader._xor_key, kw)) or b'decoded'
        bind_target_probe(downloader)
        bind_target_probe(downloader)
        self.assertEqual(downloader.decrypt_image(target, aes_key='example'), b'decoded')
        self.assertEqual(observed, [(probe, None, {'aes_key': 'example'})])

    def test_cdn_sticker_verifies_hash_and_samples_gif(self):
        frames = [Image.new('RGB', (12, 10), color) for color in ('red', 'green', 'blue')]
        buf = io.BytesIO()
        frames[0].save(buf, format='GIF', save_all=True, append_images=frames[1:], duration=100)
        raw = buf.getvalue()
        digest = hashlib.md5(raw).hexdigest()
        content = '<msg><emoji md5 = "' + digest + '" cdnurl="https://wxapp.tc.qq.com/a?a=1&amp;b=2"/></msg>'
        fetch = Mock(return_value=raw)
        preview, count = emoji_vision.load_preview(self.root, content, allow_network=True, fetch=fetch)
        self.assertEqual(count, 3)
        self.assertEqual(Image.open(io.BytesIO(preview)).format, 'PNG')
        fetch.assert_called_once_with('https://wxapp.tc.qq.com/a?a=1&b=2')
        self.assertIsNone(emoji_vision.load_preview(self.root, content, allow_network=True, fetch=lambda u: b'wrong asset'))

    def test_sticker_network_is_explicit_and_rejects_untrusted_hosts(self):
        for url in ('http://127.0.0.1/a', 'https://wxapp.tc.qq.com.evil.example/a'):
            fetch = Mock()
            content = '<emoji md5="' + 'a' * 32 + '" cdnurl="' + url + '"/>'
            self.assertIsNone(emoji_vision.load_preview(self.root, content, allow_network=True, fetch=fetch))
            fetch.assert_not_called()
        fetch = Mock()
        content = '<emoji md5="' + 'a' * 32 + '" cdnurl="https://wxapp.tc.qq.com/a"/>'
        self.assertIsNone(emoji_vision.load_preview(self.root, content, fetch=fetch))
        fetch.assert_not_called()

    def test_local_sticker_without_extension(self):
        digest = hashlib.md5(self.image.read_bytes()).hexdigest()
        path = self.root / 'cache/2026-11/Emoticon' / digest[:2] / digest
        path.parent.mkdir(parents=True)
        path.write_bytes(self.image.read_bytes())
        preview, count = emoji_vision.load_preview(self.root, '<emoji md5="' + digest + '"/>')
        self.assertEqual(count, 1)
        self.assertEqual(Image.open(io.BytesIO(preview)).size, (40, 30))

    @unittest.skipUnless(HAS_CRYPTO, '需要 cryptography 才能校验 AES 回源解密')
    def test_encrypted_cdn_sticker_is_verified_after_decryption(self):
        raw = self.image.read_bytes()
        key = bytes(range(16))
        padding = 16 - len(raw) % 16
        cipher = Cipher(algorithms.AES(key), modes.CBC(bytes(16))).encryptor()
        encrypted = cipher.update(raw + bytes([padding]) * padding) + cipher.finalize()
        content = '<emoji md5="' + hashlib.md5(raw).hexdigest() + '" aeskey="' + key.hex() + '" encrypturl="https://wxapp.tc.qq.com/a"/>'
        self.assertIsNotNone(emoji_vision.load_preview(self.root, content, allow_network=True, fetch=lambda u: encrypted))


class MediaFailureLogTests(unittest.TestCase):
    """识别失败照旧不回话，但日志要能回答「这条消息她为什么没回」。

    以前的失败路径只有一个 return：内部日志没有消息 id，事后只能猜。
    """

    def env(self, stubs):
        # log_throttled 用真身跑：节流行为本身就是这次要验证的东西
        clock = types.SimpleNamespace(now=1_700_000_000.0)
        clock.time = lambda: clock.now
        env = dict(
            me='self',
            time=clock,
            _THROTTLE_LOG={},
            log=Mock(),
            log_error=Mock(),
            display_name=lambda chat: '好友',
            db=types.SimpleNamespace(get_nickname=lambda sender: '张三'),
            LOCAL_HTTP=types.SimpleNamespace(post=Mock()),   # 真连微信/服务端的替身
        )
        env.update(stubs)
        env['log_throttled'] = nested('log_throttled', env)
        # on_message_inner 会调用模块级 fix_garbled（0eba2cb 的乱码还原），单函数抽取要一起带上
        env['fix_garbled'] = nested('fix_garbled', env)
        env['on_message_inner'] = nested('on_message_inner', env)
        return env

    def message(self, mtype, **changes):
        msg = dict(username='peer', sender_username='friend', type=mtype, content='',
                   local_id=7, shard='shard1', create_time=200.)
        msg.update(changes)
        return msg

    def error_line(self, env):
        env['log_error'].assert_called_once()
        return env['log_error'].call_args.args[0]

    def test_image_failure_logs_error_and_sends_nothing(self):
        env = self.env({'describe_image': Mock(return_value='')})
        msg = self.message('图片')
        env['on_message_inner'](msg, None)
        env['describe_image'].assert_called_once_with(msg)
        line = self.error_line(env)
        for piece in ('会话=好友', '发送者=张三', '类型=图片', '消息id=peer:shard1:7', '空描述'):
            self.assertIn(piece, line)
        env['LOCAL_HTTP'].post.assert_not_called()

    def test_emoji_failure_logs_error_and_sends_nothing(self):
        env = self.env({'describe_emoji': Mock(return_value='')})
        msg = self.message('表情', content='<emoji md5="deadbeef"/>')
        env['on_message_inner'](msg, None)
        env['describe_emoji'].assert_called_once_with(msg)
        line = self.error_line(env)
        self.assertIn('类型=表情', line)
        self.assertIn('消息id=peer:shard1:7', line)
        env['LOCAL_HTTP'].post.assert_not_called()

    def test_voice_failure_logs_error_and_sends_nothing(self):
        env = self.env({'transcribe_voice': Mock(return_value='')})
        msg = self.message('语音')
        env['on_message_inner'](msg, None)
        line = self.error_line(env)
        self.assertIn('类型=语音', line)
        self.assertIn('消息id=peer:shard1:7', line)
        env['LOCAL_HTTP'].post.assert_not_called()

    def test_success_keeps_error_log_silent(self):
        env = self.env({'describe_image': Mock(return_value='一张蓝色图片')})
        # 名单不匹配让函数在「识别成功之后」提前返回，不碰真正的发送链路
        env['ONLY_CHATS'] = ['不在名单里的会话']
        env['on_message_inner'](self.message('图片'), None)
        env['log_error'].assert_not_called()
        self.assertFalse([k for k in env['_THROTTLE_LOG'] if k.startswith('media-fail')])

    def test_same_message_is_throttled_to_one_error_line(self):
        env = self.env({'describe_image': Mock(return_value='')})
        msg = self.message('图片')
        env['on_message_inner'](msg, None)
        env['on_message_inner'](msg, None)
        env['log_error'].assert_called_once()
        keys = [k for k in env['_THROTTLE_LOG'] if k.startswith('media-fail')]
        self.assertEqual(len(keys), 1)
        self.assertIn('peer:shard1:7', keys[0], '节流 key 要带消息 id，别把别的消息一起吞掉')

    def test_exception_type_is_carried_into_the_error_line(self):
        # 落盘路径不存在 → getsize 抛 FileNotFoundError，异常类型要能带回消息上
        missing = str(ROOT / ('missing-image-%s.png' % uuid.uuid4().hex))
        env = dict(os=os, time=types.SimpleNamespace(sleep=lambda *_: None),
                   bot_url='http://localhost/webhook/wechat', log=Mock(), log_throttled=Mock(),
                   _get_media=lambda: types.SimpleNamespace(download_image=lambda *a, **k: missing),
                   LOCAL_HTTP=types.SimpleNamespace(post=Mock()))
        msg = {'username': 'peer', 'local_id': 7, 'shard': 'shard1'}
        self.assertEqual(nested('describe_image', env)(msg), '')
        self.assertEqual(msg.get('_media_fail'), 'FileNotFoundError')
        env['LOCAL_HTTP'].post.assert_not_called()


if __name__ == '__main__':
    unittest.main()
