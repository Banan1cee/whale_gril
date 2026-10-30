"""DigestBridge 适配层：只验参数映射与 fail-closed，不联网、不碰微信。

调度/重试的细节由 test_digest_worker.py 覆盖；这里守的是「桥接把什么交给它」。
"""
import importlib.util
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
# digest_watch 用「bridge/ 在 sys.path 上」的脚本式导入，单独按路径加载时要补一下
if str(ROOT / 'bridge') not in sys.path:
    sys.path.insert(0, str(ROOT / 'bridge'))
spec = importlib.util.spec_from_file_location('digest_watch', ROOT / 'bridge/digest_watch.py')
dw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(dw)


class FakeResponse:
    def __init__(self, data, status=200):
        self._data = data
        self.status_code = status

    def json(self):
        return self._data


class Recorder:
    def __init__(self, data=None, status=200, raises=None):
        self.calls = []
        self.data = data if data is not None else {'ok': True}
        self.status = status
        self.raises = raises

    def __call__(self, url, params=None, timeout=None):
        self.calls.append({'url': url, 'params': params, 'timeout': timeout})
        if self.raises:
            raise self.raises
        return FakeResponse(self.data, self.status)


def make(http_get):
    sent = []

    def resolve(wxid):
        return ('wxid_master', '主人') if wxid == 'wxid_master' else ''

    def send(text, shown, canonical, send_guard=None):
        sent.append({'text': text, 'shown': shown, 'canonical': canonical,
                     'guard': bool(send_guard() if callable(send_guard) else False)})
        return True

    bridge = dw.DigestBridge(
        read_config=lambda: {},
        base_url='http://127.0.0.1:8787/',
        http_get=http_get,
        resolve_recipient=resolve,
        send_text=send,
        can_send=lambda: True,
        account='acc',
    )
    return bridge, sent


class FetchTests(unittest.TestCase):
    def test_window_query_maps_to_digest_endpoint(self):
        rec = Recorder({'ok': True})
        bridge, _ = make(rec)
        bridge.fetch({'since': 1000, 'until': 2000, 'maxItems': 30})
        call = rec.calls[0]
        self.assertEqual(call['url'], 'http://127.0.0.1:8787/api/digest')
        self.assertEqual(call['params'], {'since': 1000, 'until': 2000, 'maxItems': 30})
        self.assertIsNotNone(call['timeout'])

    def test_check_query_carries_generation_only(self):
        rec = Recorder({'ok': True})
        bridge, _ = make(rec)
        bridge.fetch({'check': 1, 'generation': 'g-1'})
        self.assertEqual(rec.calls[0]['params'], {'check': 1, 'generation': 'g-1'})

    def test_non_200_raises_so_worker_can_retry(self):
        bridge, _ = make(Recorder({'ok': False}, status=404))
        with self.assertRaises(RuntimeError):
            bridge.fetch({'since': 0, 'until': 10})

    def test_non_object_json_raises(self):
        bridge, _ = make(Recorder([1, 2, 3]))
        with self.assertRaises(ValueError):
            bridge.fetch({'since': 0, 'until': 10})


class ResolveAndSendTests(unittest.TestCase):
    def test_unknown_or_ambiguous_recipient_is_empty(self):
        bridge, _ = make(Recorder())
        self.assertEqual(bridge.resolve('wxid_master'), ('wxid_master', '主人'))
        self.assertEqual(bridge.resolve('wxid_other'), '')
        # 解析函数抛异常也不能把线程带崩
        bridge.resolve_recipient = lambda _wxid: (_ for _ in ()).throw(RuntimeError('db locked'))
        self.assertEqual(bridge.resolve('wxid_master'), '')

    def test_send_requires_guard_and_passes_canonical_id(self):
        bridge, sent = make(Recorder())
        self.assertFalse(bridge.send('汇总', ('wxid_master', '主人'), None))
        self.assertEqual(sent, [], '没有 guard 不能发')
        self.assertTrue(bridge.send('汇总', ('wxid_master', '主人'), lambda: True))
        self.assertEqual(sent[0]['canonical'], 'wxid_master')
        self.assertTrue(sent[0]['guard'], 'send_text 里要能再复核一次')

    def test_malformed_target_does_not_raise(self):
        bridge, sent = make(Recorder())
        self.assertFalse(bridge.send('汇总', 'wxid_master', lambda: True))
        self.assertEqual(sent, [])


if __name__ == '__main__':
    unittest.main()
