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
spec = importlib.util.spec_from_file_location('digest_worker', ROOT / 'examples/digest_worker.py')
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


BRIDGE = ROOT / 'examples/wechatauto_bridge.py'
TREE = ast.parse(BRIDGE.read_text(encoding='utf-8'))
MAIN = next(node for node in TREE.body if isinstance(node, ast.FunctionDef) and node.name == 'main')


def bridge_function(name, scope):
    node = copy.deepcopy(next(node for node in MAIN.body if isinstance(node, ast.FunctionDef) and node.name == name))
    node.body = [ast.Global(names=item.names) if isinstance(item, ast.Nonlocal) else item for item in node.body]
    exec(compile(ast.fix_missing_locations(ast.Module(body=[node], type_ignores=[])), '<mock bridge>', 'exec'), scope)
    return scope[name]


class BridgeGuardTests(unittest.TestCase):
    def test_send_text_rechecks_after_send_lock_without_any_ui_side_effect(self):
        allowed = [True]
        class RaceLock:
            def __enter__(self): allowed[0] = False
            def __exit__(self, *args): pass
        scope = {'gui': object(), 'dead_chats': set(), 'group_is_alive': lambda username: True,
                 'account_send_allowed': lambda where: True, 'send_lock': RaceLock(),
                 'sticker_quarantine_allows': Mock(), 'log': Mock()}
        send = bridge_function('send_text', scope)
        self.assertFalse(send('private', 'Master', 'wxid_master', send_guard=lambda: allowed[0],
                              target_aliases=frozenset({'Master'})))
        scope['sticker_quarantine_allows'].assert_not_called()

    def test_guarded_send_never_calls_keyboard_ocr_or_retry_paths(self):
        uia_send = Mock(return_value=False)
        gui = types.SimpleNamespace()
        scope = {'gui': gui, 'dead_chats': set(), 'group_is_alive': lambda username: True,
                 'account_send_allowed': lambda where: True, 'send_lock': threading.Lock(),
                 'gui_lock': threading.Lock(), 'sticker_quarantine_allows': lambda *args: True,
                 'bind_gui_window': Mock(), 'ACCOUNT': {'verified': True}, 'uia_send': uia_send,
                 'with_window_on_top': Mock(side_effect=AssertionError('retry wrapper forbidden')),
                 'force_send_foreground': lambda fn: fn(), 'BACKGROUND_SEND': True,
                 'snapshot_win_state': Mock(return_value='snapshot'), 'restore_win_state': Mock(),
                 'SEND_STATE': {}, 'time': types.SimpleNamespace(time=lambda: 1),
                 'keyboard_send': Mock(), 'log': Mock()}
        send = bridge_function('send_text', scope)
        self.assertFalse(send('private', 'Master', 'wxid_master', send_guard=lambda: True,
                              target_aliases=frozenset({'Master'})))
        uia_send.assert_called_once()
        scope['keyboard_send'].assert_not_called()
        scope['with_window_on_top'].assert_not_called()
        scope['restore_win_state'].assert_called_once_with('snapshot')
        self.assertFalse(scope['SEND_STATE']['active'])

    def uia_scope(self):
        uia = types.SimpleNamespace(current_chat=Mock(return_value='Other'),
                                    open_chat=Mock(return_value=True), send_text=Mock(return_value=True),
                                    back_to_chat_tab=Mock())
        gui = types.SimpleNamespace(_get_uia=lambda: uia, _uia=uia)
        scope = {'gui': gui, 'gui_lock': threading.Lock(), 'account_send_allowed': lambda *args: True,
                 'wechat_window_alive': lambda: True, 'UIA_CACHE': {'u': uia}, 'BACKGROUND_SEND': False,
                 'open_cache': {}, 'ACCOUNT': {'verified': True, 'hwnd': 123}, 'log': Mock(),
                 'time': types.SimpleNamespace(time=lambda: 1),
                 'quarantined_input_value': Mock(return_value=''),
                 'sticker_input_is_blank': lambda value: isinstance(value, str) and not value.strip(),
                 'press_enter': Mock()}
        control = types.SimpleNamespace(SendKeys=Mock())
        uia._chat_input = Mock(return_value=control)
        def paste(ctrl, text, clear=False):
            scope['quarantined_input_value'].return_value = text
        uia._paste_into = Mock(side_effect=paste)
        scope['WindowsDesktop'] = lambda: types.SimpleNamespace(foreground=lambda hwnd: True,
                                                               focused=lambda ctrl, hwnd: True)
        scope['sticker_draft_quarantine'] = {}
        scope['guarded_text_once'] = module.guarded_text_once
        return scope, uia

    def test_uia_digest_checks_exact_target_after_navigation(self):
        scope, uia = self.uia_scope()
        send = bridge_function('uia_send', scope)
        self.assertFalse(send('private', 'Master', 'wxid_master', lambda: True, {'Master'}))
        uia.send_text.assert_not_called()

    def test_uia_digest_checks_gate_after_navigation_and_draft(self):
        scope, uia = self.uia_scope(); uia.current_chat.return_value = 'Master'
        send = bridge_function('uia_send', scope)
        self.assertFalse(send('private', 'Master', 'wxid_master', lambda: False, {'Master'}))
        uia.send_text.assert_not_called()
        scope['quarantined_input_value'].return_value = 'user draft'
        self.assertFalse(send('private', 'Master', 'wxid_master', lambda: True, {'Master'}))
        uia.send_text.assert_not_called()

    def test_uia_digest_rechecks_target_after_network_gate(self):
        scope, uia = self.uia_scope(); uia.current_chat.return_value = 'Master'
        def gate():
            uia.current_chat.return_value = 'Other'
            return True
        send = bridge_function('uia_send', scope)
        self.assertFalse(send('private', 'Master', 'wxid_master', gate, {'Master'}))
        uia.send_text.assert_not_called()

    def test_uia_digest_one_attempt_no_extra_enter_even_on_failure(self):
        for outcome in [True, False]:
            scope, uia = self.uia_scope(); uia.current_chat.return_value = 'Master'
            control = uia._chat_input()
            if not outcome:
                control.SendKeys.side_effect = RuntimeError('uncertain Enter delivery')
            send = bridge_function('uia_send', scope)
            self.assertEqual(send('private', 'Master', 'wxid_master', lambda: True, {'Master'}), outcome)
            uia.send_text.assert_not_called()
            uia._paste_into.assert_called_once_with(control, 'private', clear=False)
            control.SendKeys.assert_called_once_with('{Enter}', waitTime=0.05)
            scope['press_enter'].assert_not_called()
            self.assertTrue(scope['sticker_draft_quarantine']['wxid_master']['draft_observed'])

    def test_off_after_digest_paste_no_enter_and_draft_quarantined(self):
        scope, uia = self.uia_scope(); uia.current_chat.return_value = 'Master'
        checks = [True, False]
        send = bridge_function('uia_send', scope)
        self.assertFalse(send('private', 'Master', 'wxid_master', lambda: checks.pop(0), {'Master'}))
        uia._paste_into.assert_called_once()
        uia._chat_input().SendKeys.assert_not_called()
        self.assertEqual(scope['sticker_draft_quarantine']['wxid_master'], {
            'hwnd': 123, 'aliases': {'Master'}, 'draft_observed': True})

    def test_partial_digest_paste_exception_no_enter_no_retry(self):
        scope, uia = self.uia_scope(); uia.current_chat.return_value = 'Master'
        def partial(control, text, clear=False):
            scope['quarantined_input_value'].return_value = 'private par'
            raise RuntimeError('clipboard/UIA partial failure')
        uia._paste_into.side_effect = partial
        send = bridge_function('uia_send', scope)
        self.assertFalse(send('private', 'Master', 'wxid_master', lambda: True, {'Master'}))
        uia._paste_into.assert_called_once()
        uia._chat_input().SendKeys.assert_not_called()
        self.assertTrue(scope['sticker_draft_quarantine']['wxid_master']['draft_observed'])

    def test_digest_cancelled_draft_blocks_later_ordinary_sends_even_off(self):
        scope, uia = self.uia_scope(); uia.current_chat.return_value = 'Master'
        checks = [True, False]
        send = bridge_function('uia_send', scope)
        self.assertFalse(send('private', 'Master', 'wxid_master', lambda: checks.pop(0), {'Master'}))
        scope['_compat_mod'] = lambda: types.SimpleNamespace(pinned_window=lambda: 123)
        scope['log_throttled'] = Mock()
        quarantine = bridge_function('sticker_quarantine_allows', scope)
        self.assertFalse(quarantine('wxid_master', 'Master'))
        uia._chat_input().SendKeys.assert_not_called()
        scope['quarantined_input_value'].return_value = '\n'
        self.assertTrue(quarantine('wxid_master', 'Master'))
        self.assertEqual(scope['sticker_draft_quarantine'], {})

    def test_digest_user_focus_or_text_change_during_last_epoch_check_no_enter(self):
        for change in ['target', 'text', 'account', 'focus']:
            scope, uia = self.uia_scope(); uia.current_chat.return_value = 'Master'
            calls = [0]
            def gate():
                calls[0] += 1
                if calls[0] == 2:
                    if change == 'target': uia.current_chat.return_value = 'Other'
                    if change == 'text': scope['quarantined_input_value'].return_value = 'different text'
                    if change == 'account': scope['ACCOUNT']['hwnd'] = 999
                    if change == 'focus': scope['WindowsDesktop'] = lambda: None
                return True
            if change == 'focus':
                scope['WindowsDesktop'] = lambda: types.SimpleNamespace(
                    foreground=lambda hwnd: True, focused=lambda ctrl, hwnd: calls[0] < 2)
            send = bridge_function('uia_send', scope)
            self.assertFalse(send('private', 'Master', 'wxid_master', gate, {'Master'}))
            uia._chat_input().SendKeys.assert_not_called()

    def test_removed_game_away_queue_symbols_and_resting_branch_absent(self):
        names = {node.id for node in ast.walk(TREE) if isinstance(node, ast.Name)}
        for removed in ['GAME_PAUSE', 'GAME_PAUSE_ENABLED', 'AWAY', 'AWAY_STATE', 'QUEUE',
                        'queued_replies', 'resting', 'chat_latest_seq', 'away_watch', 'game_watch']:
            self.assertNotIn(removed, names)
        heartbeat = next(node for node in MAIN.body if isinstance(node, ast.FunctionDef) and node.name == 'bridge_heartbeat')
        rest_values = [value.value for node in ast.walk(heartbeat) if isinstance(node, ast.Dict)
                       for key, value in zip(node.keys, node.values)
                       if isinstance(key, ast.Constant) and key.value == 'rest' and isinstance(value, ast.Constant)]
        self.assertEqual(rest_values, [False])


if __name__ == '__main__':
    unittest.main(verbosity=2)
