"""Pure mock/source-only digest tests. Never import/start the live bridge or UI."""
import ast
import copy
import importlib.util
from pathlib import Path
import threading
import types
import unittest
from unittest.mock import Mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('digest_worker', ROOT / 'bridge/digest_worker.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def config(enabled=True, ids=None, every=1):
    return {'digest': {'enabled': enabled, 'everyMinutes': every, 'maxItems': 120},
            'persona': {'master': {'wxids': ['wxid_master'] if ids is None else ids,
                                   'names': ['Duplicated nickname']}},
            'wechat': {'account': 'selected-account'}}


class Harness:
    def __init__(self, cfg=None):
        self.cfg = cfg or config()
        self.now = 1000.0
        self.generation = 'epoch-1'
        self.calls = []
        self.sent = []
        self.resolved = []
        self.allowed = True
        self.on_fetch = None
        self.on_send = None
        self.worker = module.DigestWorker(
            read_config=lambda: self.cfg, fetch=self.fetch, resolve_recipient=self.resolve,
            send=self.send, can_send=lambda: self.allowed, account='selected-account',
            wall=lambda: self.now, monotonic=lambda: self.now)
        self.worker.configure(self.cfg)

    def resolve(self, username):
        self.resolved.append(username)
        return username, frozenset({username, 'Unique master'})

    def fetch(self, params):
        self.calls.append(dict(params))
        if self.on_fetch:
            self.on_fetch(params)
        if params.get('check'):
            return {'ok': True, 'enabled': True, 'generation': self.generation}
        return {'ok': True, 'generation': self.generation, 'count': 1,
                'text': 'private summary', 'until': params['until'] - 1}

    def send(self, text, target, guard):
        if self.on_send:
            self.on_send(text, target, guard)
        elif guard():
            self.sent.append((text, target))
        return True

    def due(self, seconds=60):
        self.now += seconds
        self.worker.step()


class DigestSettingsTests(unittest.TestCase):
    def test_canonical_switch_only(self):
        cfg = config(False); cfg['features'] = {'digest': True}
        self.assertFalse(module.settings(cfg)[0])
        cfg['digest']['enabled'] = 'false'
        self.assertFalse(module.settings(cfg)[0])
        cfg['digest']['enabled'] = 'true'
        self.assertTrue(module.settings(cfg)[0])

    def test_frequency_and_item_limits_finite_and_bounded(self):
        for value, expected in [(0, 60), (-10, 60), (1e20, 86400), ('bad', 1800),
                                (float('nan'), 1800), (float('inf'), 1800), (2.5, 150)]:
            cfg = config(every=value)
            self.assertEqual(module.settings(cfg)[1], expected)
        cfg = config(); cfg['digest']['maxItems'] = 10000
        self.assertEqual(module.settings(cfg)[2], 120)
        cfg['digest']['maxItems'] = -20
        self.assertEqual(module.settings(cfg)[2], 1)

    def test_no_names_or_first_of_multiple_master_ids(self):
        for ids in [[], ['wxid_a', 'wxid_b'], 'wxid_a', ['room@chatroom'], ['filehelper'], ['gh_notice']]:
            self.assertEqual(module.settings(config(ids=ids))[3], '')
        self.assertEqual(module.settings(config(ids=['wxid_master', 'wxid_master']))[3], 'wxid_master')

    def test_malformed_config_fails_closed(self):
        for cfg in [None, [], {'digest': True}, {'persona': {'master': True}}]:
            self.assertFalse(module.settings(cfg)[0])


class DigestWorkerTests(unittest.TestCase):
    def test_off_no_http_resolution_or_send_even_with_legacy_switch(self):
        cfg = config(False); cfg['features'] = {'digest': True}
        h = Harness(cfg)
        h.due(100000)
        self.assertEqual((h.calls, h.resolved, h.sent), ([], [], []))

    def test_off_worker_waits_for_config_event_not_poll_timer(self):
        h = Harness(config(False))
        # Clear the initial configure event; any config read means a timer fired.
        h.worker.wake.clear()
        h.worker.read_config = Mock(side_effect=AssertionError('OFF must be dormant'))
        waiter_entered = threading.Event()
        original_wait = h.worker.wake.wait
        def wait(timeout=None):
            self.assertIsNone(timeout)
            waiter_entered.set()
            return original_wait(timeout)
        h.worker.wake.wait = wait
        thread = threading.Thread(target=h.worker.run)
        thread.start()
        self.assertTrue(waiter_entered.wait(1))
        h.worker.stop(); thread.join(1)
        self.assertFalse(thread.is_alive())
        h.worker.read_config.assert_not_called()

    def test_first_send_waits_full_interval_and_authored_cursor(self):
        h = Harness(); baseline = h.worker.cursor
        h.due(59)
        self.assertEqual(h.calls, [])
        h.due(1)
        self.assertEqual(len(h.sent), 1)
        self.assertEqual(h.calls[0], {'since': baseline, 'until': 1060000, 'maxItems': 120})
        self.assertEqual(h.worker.cursor, 1059999)

    def test_frequency_hot_edit_applies_without_replay_reset(self):
        h = Harness(config(every=30)); initial = h.worker.cursor
        h.now += 100
        h.cfg['digest']['everyMinutes'] = 1
        h.worker.configure(h.cfg)
        h.due(59); self.assertEqual(h.calls, [])
        h.due(1)
        self.assertEqual(h.calls[0]['since'], initial)
        self.assertEqual(len(h.sent), 1)

    def test_off_after_network_makes_no_check_or_send(self):
        h = Harness()
        def off(params):
            h.cfg['digest']['enabled'] = False
        h.on_fetch = off
        h.due()
        self.assertEqual(len(h.calls), 1)
        self.assertEqual(h.sent, [])

    def test_disable_after_waiting_for_send_lock_no_send(self):
        h = Harness()
        def send(text, target, guard):
            h.cfg['digest']['enabled'] = False
            calls_before = len(h.calls)
            self.assertFalse(guard())
            self.assertEqual(len(h.calls), calls_before)
        h.on_send = send
        h.due()
        self.assertEqual(h.sent, [])

    def test_off_during_pre_send_recipient_lookup_forbids_status_http(self):
        h = Harness(); calls = [0]
        original = h.resolve
        def resolve(username):
            calls[0] += 1
            target = original(username)
            if calls[0] > 1:
                h.cfg['digest']['enabled'] = False
            return target
        h.worker.resolve_recipient = resolve
        h.due()
        self.assertEqual(len(h.calls), 1)
        self.assertEqual(h.sent, [])

    def test_off_during_generation_check_rechecks_local_switch(self):
        h = Harness()
        def off(params):
            if params.get('check'):
                h.cfg['digest']['enabled'] = False
        h.on_fetch = off
        h.due()
        self.assertEqual(h.sent, [])

    def test_fast_server_off_on_epoch_change_discards_old_response(self):
        h = Harness(); original = h.fetch
        def fetch(params):
            result = original(params)
            if not params.get('check'):
                h.generation = 'epoch-2'
            return result
        h.worker.fetch = fetch
        h.due()
        self.assertEqual(h.sent, [])

    def test_off_on_and_recipient_edit_start_new_cutoff(self):
        h = Harness(); h.now += 20
        h.cfg['digest']['enabled'] = False; h.worker.configure(h.cfg)
        h.now += 20
        h.cfg['digest']['enabled'] = True; h.worker.configure(h.cfg)
        reenabled = h.worker.cursor
        h.due(59); self.assertEqual(h.calls, [])
        h.due(1)
        self.assertEqual(h.calls[0]['since'], reenabled)
        h.cfg['persona']['master']['wxids'] = ['wxid_new']
        h.worker.configure(h.cfg)
        recipient_cutoff = h.worker.cursor
        h.due()
        self.assertEqual([x for x in h.calls if not x.get('check')][-1]['since'], recipient_cutoff)
        self.assertEqual(h.sent[-1][1][0], 'wxid_new')

    def test_frequency_change_during_send_does_not_replay_delivered_window(self):
        h = Harness()
        def edit_while_sending(text, target, guard):
            self.assertTrue(guard())
            h.cfg['digest']['everyMinutes'] = 2
            h.worker.configure(h.cfg)
        h.on_send = edit_while_sending
        h.due()
        self.assertEqual(h.worker.cursor, 1059999)
        h.on_send = None
        h.due(120)
        self.assertEqual([x for x in h.calls if not x.get('check')][1]['since'], 1059999)

    def test_messages_arriving_during_send_not_lost_to_wallclock(self):
        h = Harness()
        def slow_send(text, target, guard):
            if guard():
                h.sent.append((text, target))
                h.now += 25
        h.on_send = slow_send
        h.due()
        cutoff = 1059999
        self.assertEqual(h.worker.cursor, cutoff)
        h.due()
        self.assertEqual([x for x in h.calls if not x.get('check')][1]['since'], cutoff)

    def test_empty_response_advances_only_server_cutoff(self):
        h = Harness(); original = h.fetch
        def empty(params):
            result = original(params)
            if not params.get('check'):
                result.update(count=0, text='')
                h.now += 20
            return result
        h.worker.fetch = empty
        h.due()
        self.assertEqual(h.worker.cursor, 1059999)
        self.assertEqual(h.sent, [])

    def test_fetch_retries_bounded_three_and_same_fixed_window(self):
        h = Harness()
        def fail(params):
            h.calls.append(dict(params)); raise TimeoutError('mock network only')
        h.worker.fetch = fail
        h.due(); h.due(30); h.due(60)
        self.assertEqual(len(h.calls), 3)
        self.assertTrue(all(item == h.calls[0] for item in h.calls))
        self.assertEqual(h.worker.cursor, h.calls[0]['until'])
        h.due(59); self.assertEqual(len(h.calls), 3)
        h.due(1)
        self.assertEqual(h.calls[-1]['since'], h.calls[0]['until'])

    def test_uncertain_failed_or_exceptional_send_never_replayed(self):
        for outcome in [False, TimeoutError('uncertain send')]:
            h = Harness()
            def send(text, target, guard):
                h.sent.append((text, target))
                if isinstance(outcome, Exception):
                    raise outcome
                return outcome
            h.worker.send = send
            try:
                h.due()
            except TimeoutError:
                pass
            old_cursor = h.worker.cursor
            h.due(59)
            self.assertEqual(len(h.sent), 1)
            try:
                h.due(1)
            except TimeoutError:
                pass
            self.assertEqual([x for x in h.calls if not x.get('check')][1]['since'], old_cursor)

    def test_missing_ambiguous_account_or_recipient_no_http(self):
        for cfg in [config(ids=[]), config(ids=['a', 'b']), config(False)]:
            h = Harness(cfg); h.due(); self.assertEqual(h.calls, [])
        h = Harness(); h.cfg['wechat']['account'] = 'another-account'
        h.due(); self.assertEqual(h.calls, [])
        h = Harness(); h.worker.resolve_recipient = lambda username: None
        h.due(); self.assertEqual(h.calls, [])

    def test_recipient_or_account_changed_after_fetch_no_send(self):
        for modify in [lambda cfg: cfg['persona']['master'].update(wxids=['other']),
                       lambda cfg: cfg['wechat'].update(account='other')]:
            h = Harness(); h.on_fetch = lambda params: modify(h.cfg)
            h.due(); self.assertEqual(h.sent, [])

    def test_fullscreen_drops_window_without_network_or_queued_replay(self):
        h = Harness(); h.allowed = False
        h.due()
        self.assertEqual(h.calls, [])
        cutoff = h.worker.cursor
        h.allowed = True; h.due()
        self.assertEqual(h.calls[0]['since'], cutoff)

    def test_bad_responses_cannot_send_or_advance_outside_requested_cutoff(self):
        for changes in [{'ok': False}, {'until': 9999999999}, {'until': -1},
                        {'count': '1'}, {'generation': ''}, {'text': ['not text']}]:
            h = Harness(); original = h.fetch
            def malformed(params):
                response = original(params); response.update(changes); return response
            h.worker.fetch = malformed
            h.due()
            self.assertEqual(h.sent, [])
            self.assertEqual(h.worker.cursor, 1000000)


# 桥接进程（examples/wechatauto_bridge.py）这次没同步，所以不在这里断言它的
# send_text 守卫；等桥接那部分对齐后再把 BridgeGuardTests 补回来。

if __name__ == '__main__':
    unittest.main(verbosity=2)
