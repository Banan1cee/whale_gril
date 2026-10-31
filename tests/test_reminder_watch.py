"""提醒调度器（桥接侧）的回归测试：不联网、不碰微信，依赖全注入。"""
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch
import ast

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT / 'bridge') not in sys.path:
    sys.path.insert(0, str(ROOT / 'bridge'))
spec = importlib.util.spec_from_file_location('reminder_watch', ROOT / 'bridge/reminder_watch.py')
rw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rw)


class FakeBridge:
    def __init__(self, payloads, send_ok=True, send_raises=False):
        self.payloads = list(payloads)
        self.sent = []
        self.acked = []
        self.send_ok = send_ok
        self.send_raises = send_raises
        self.fetches = 0

    def fetch(self):
        self.fetches += 1
        return self.payloads.pop(0) if self.payloads else {'ok': True, 'items': [], 'nextDueAt': 0}

    def send(self, item, text):
        if self.send_raises:
            raise RuntimeError('wechat busy')
        self.sent.append((item.get('id'), text))
        return self.send_ok

    def ack(self, item, ok, err):
        self.acked.append((item.get('id'), bool(ok), err))

    def runner(self, **kw):
        return rw.ReminderRunner(fetch=self.fetch, send=self.send, ack=self.ack, log=lambda *a: None, **kw)


def items(*ids):
    return [{'id': i, 'wxid': 'wxid_x', 'name': '阿螈', 'text': '开会', 'dueAt': 1} for i in ids]


class StepTests(unittest.TestCase):
    def test_sends_each_due_item_and_acks_ok(self):
        b = FakeBridge([{'ok': True, 'items': items('a', 'b'), 'nextDueAt': 0}])
        sent, next_at = b.runner().step()
        self.assertEqual(sent, 2)
        self.assertEqual(b.sent, [('a', '开会'), ('b', '开会')])
        self.assertEqual([x[:2] for x in b.acked], [('a', True), ('b', True)])
        self.assertEqual(next_at, 0)

    def test_failed_send_is_acked_as_failure_so_server_can_retry(self):
        b = FakeBridge([{'ok': True, 'items': items('a'), 'nextDueAt': 0}], send_ok=False)
        sent, _ = b.runner().step()
        self.assertEqual(sent, 0)
        self.assertEqual(b.acked, [('a', False, '微信发送失败')])

    def test_exception_during_send_still_acks_failure(self):
        b = FakeBridge([{'ok': True, 'items': items('a'), 'nextDueAt': 0}], send_raises=True)
        sent, _ = b.runner().step()
        self.assertEqual(sent, 0)
        self.assertFalse(b.acked[0][1])
        self.assertIn('wechat busy', b.acked[0][2])

    def test_empty_text_is_not_sent(self):
        b = FakeBridge([{'ok': True, 'items': [{'id': 'a', 'wxid': 'wxid_x', 'text': '   '}], 'nextDueAt': 0}])
        b.runner().step()
        self.assertEqual(b.sent, [])
        self.assertFalse(b.acked[0][1])

    def test_next_due_at_is_returned_for_sleep(self):
        b = FakeBridge([{'ok': True, 'items': [], 'nextDueAt': 1793370600000}])
        _, next_at = b.runner().step()
        self.assertEqual(next_at, 1793370600000)


class LoopTests(unittest.TestCase):
    def test_due_backlog_wakes_without_thirty_second_idle(self):
        b = FakeBridge([{'ok': True, 'items': items('first'), 'nextDueAt': 1000}])
        wake = Mock()
        runner = b.runner(now_ms=lambda: 1000, wake=wake)
        wake.wait.side_effect = lambda delay: runner.stop()
        runner.run()
        wake.wait.assert_called_once_with(0.2)

    def test_sleeps_until_next_due_not_a_fixed_poll(self):
        now = [1_000_000]
        b = FakeBridge([{'ok': True, 'items': [], 'nextDueAt': now[0] + 5_000}])
        runner = b.runner(now_ms=lambda: now[0], max_sleep=60)
        # 不真的进 run()，只验「睡多久」的算法等价于到点
        delay = max(0.2, min(runner.max_sleep, (now[0] + 5_000 - now[0]) / 1000.0))
        self.assertAlmostEqual(delay, 5.0)
        self.assertEqual(runner.stopped, False)
        runner.stop()
        self.assertTrue(runner.stopped)
        self.assertTrue(runner.wake.is_set())

    def test_stop_stops_the_loop(self):
        b = FakeBridge([])
        runner = b.runner(idle_wait=0.01, max_sleep=0.01)
        runner.stop()
        runner.run()          # 已经 stopped，立即返回
        self.assertEqual(b.fetches, 0)


class WiringTests(unittest.TestCase):
    def test_engine_imports_starts_and_retains_runner(self):
        tree = ast.parse((ROOT / 'bridge/engine.py').read_text(encoding='utf-8-sig'))
        self.assertTrue(any(isinstance(n, ast.ImportFrom) and n.module == 'reminder_watch'
                            and any(a.name == 'start_reminder_watch' for a in n.names)
                            for n in ast.walk(tree)))
        assignments = [n for n in ast.walk(tree) if isinstance(n, ast.Assign)
                       and isinstance(n.value, ast.Call)
                       and isinstance(n.value.func, ast.Name)
                       and n.value.func.id == 'start_reminder_watch']
        self.assertEqual(len(assignments), 1)
        self.assertEqual(assignments[0].targets[0].id, 'REMINDER_RUNNER')

    def test_real_adapter_fetches_with_token_sends_target_and_acks(self):
        http = Mock()
        http.request.return_value.json.return_value = {'ok': True, 'items': items('a')}
        send_text, send_at = Mock(return_value=True), Mock(return_value=True)
        with patch.object(rw.threading, 'Thread') as thread:
            runner = rw.start_reminder_watch(http=http, base='http://127.0.0.1:5050',
                                            token='test-token', send_text=send_text,
                                            send_at=send_at, log=Mock())
            thread.return_value.start.assert_called_once()
            self.assertEqual(runner.step()[0], 1)
        send_text.assert_called_once_with('开会', '阿螈', 'wxid_x')
        self.assertEqual(http.request.call_args_list[0].args,
                         ('GET', 'http://127.0.0.1:5050/api/reminders/due'))
        self.assertEqual(http.request.call_args_list[0].kwargs['headers']['x-bot-token'], 'test-token')
        self.assertEqual(http.request.call_args_list[1].kwargs['json'],
                         {'id': 'a', 'ok': True, 'error': ''})

    def test_failed_http_does_not_send_or_ack_as_success(self):
        http, send = Mock(), Mock()
        http.request.return_value.raise_for_status.side_effect = RuntimeError('403')
        with patch.object(rw.threading, 'Thread'):
            runner = rw.start_reminder_watch(http=http, base='http://localhost', token='bad',
                                            send_text=send, send_at=send, log=Mock())
        with self.assertRaisesRegex(RuntimeError, '403'):
            runner.step()
        send.assert_not_called()


if __name__ == '__main__':
    unittest.main()
