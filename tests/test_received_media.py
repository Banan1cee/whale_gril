import ast
import hashlib
import io
import os
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'bridge'))
import emoji_vision
from image_cache import bind_target_probe, V2_MAGIC


def nested(name, env):
    tree = ast.parse((ROOT / 'bridge/engine.py').read_text(encoding='utf-8-sig'))
    node = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == name)
    exec(compile(ast.Module(body=[node], type_ignores=[]), '<bridge-test>', 'exec'), env)
    return env[name]


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

    def test_encrypted_cdn_sticker_is_verified_after_decryption(self):
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        raw = self.image.read_bytes()
        key = bytes(range(16))
        padding = 16 - len(raw) % 16
        cipher = Cipher(algorithms.AES(key), modes.CBC(bytes(16))).encryptor()
        encrypted = cipher.update(raw + bytes([padding]) * padding) + cipher.finalize()
        content = '<emoji md5="' + hashlib.md5(raw).hexdigest() + '" aeskey="' + key.hex() + '" encrypturl="https://wxapp.tc.qq.com/a"/>'
        self.assertIsNotNone(emoji_vision.load_preview(self.root, content, allow_network=True, fetch=lambda u: encrypted))


if __name__ == '__main__':
    unittest.main()
