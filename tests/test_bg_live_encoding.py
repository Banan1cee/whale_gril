"""模拟同一微信窗口运行时切换编码；绝不接触真实微信或输入设备。"""
import os
import sys
import unittest
import tempfile
import ast
import time
from types import SimpleNamespace
from contextlib import nullcontext
from unittest.mock import patch, Mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from bridge import bg_sender as bg


class LiveEncodingTests(unittest.TestCase):
    def setUp(self):
        self.state = dict(text='', actual='gbk', chat='测试群', sent=[], modes=[], clears=0,
                          unreadable=False, never_matches=False, clear_ok=True, switch_on_clear=False)
        state = self.state

        class Sender:
            def __init__(self, hwnd):
                pass

            def type_text(self, text, char_gap=0, strip_unencodable=True, mode='gbk'):
                state['modes'].append(mode)
                skipped = []
                if mode == 'gbk':
                    payload, skipped = bg.encode_gbk(text, strip_unencodable)
                    if payload is None:
                        return False, skipped
                    text = payload.decode('gbk')
                state['text'] = text if mode == state['actual'] and not state['never_matches'] else '¾¨乱码'
                return True, skipped

            def end_input(self):
                pass

            def click_screen(self, *xy):
                state['sent'].append(state['text'])
                state['text'] = ''

        def read(hwnd):
            value = None if state['unreadable'] and state['modes'] else state['text']
            return dict(nodes=[1] * 200, edit=object(), value=value, send_xy=(1, 2), chat=state['chat'])

        def clear(*args):
            state['clears'] += 1
            if state['clear_ok']:
                state['text'] = ''
            if state['switch_on_clear']:
                state['chat'] = '另一个群'
            return state['clear_ok']

        for name, replacement in [
            ('user32', Mock(IsIconic=lambda h: False)), ('WeChatSender', Sender),
            ('read_ui', read), ('_ensure_tree', lambda *a, **k: read(1)),
            ('open_chat', lambda *a, **k: True), ('_WriteGuard', nullcontext),
            ('_clear_composer', clear), ('_detect_char_mode_by_version', lambda h=0: 'utf16'),
        ]:
            p = patch.object(bg, name, replacement)
            p.start()
            self.addCleanup(p.stop)
        p = patch.object(bg.time, 'sleep', lambda _: None)
        p.start()
        self.addCleanup(p.stop)
        bg._DETECTED_MODES.clear()
        bg._CONFIGURED_MODES.clear()
        p = patch.object(bg, '_MODE_STATE_FILE', None)
        p.start()
        self.addCleanup(p.stop)
        p = patch.object(bg, '_LAST_MODE_STATE', '')
        p.start()
        self.addCleanup(p.stop)
        bg._DETECT_DIRTY.clear()
        self.addCleanup(bg._DETECTED_MODES.clear)
        self.addCleanup(bg._CONFIGURED_MODES.clear)

    def send(self, **kwargs):
        return bg.send('鲸鲸测试', chat='测试群', hwnd=4242, **kwargs)

    def test_hot_switch_both_directions_uses_content_and_updates_cache(self):
        self.assertEqual(self.send(), (True, 'sent'))
        self.assertEqual(self.state['modes'], ['utf16', 'gbk'])
        self.assertEqual(self.state['sent'], ['鲸鲸测试'])
        self.assertEqual(bg._DETECTED_MODES[4242], 'gbk')
        self.state['actual'] = 'utf16'
        self.state['modes'].clear()
        self.assertEqual(self.send(), (True, 'sent'))
        self.assertEqual(self.state['modes'], ['gbk', 'utf16'])
        self.assertEqual(self.state['sent'], ['鲸鲸测试', '鲸鲸测试'])
        self.assertEqual(bg._DETECTED_MODES[4242], 'utf16')

    def test_verified_mode_stays_fixed_despite_original_manual_setting(self):
        self.assertEqual(self.send(char_mode='utf16'), (True, 'sent'))
        self.assertEqual(self.state['modes'], ['utf16', 'gbk'])
        self.state['modes'].clear()
        self.assertEqual(self.send(char_mode='utf16'), (True, 'sent'))
        self.assertEqual(self.state['modes'], ['gbk'])
        self.state['actual'] = 'utf16'
        self.state['modes'].clear()
        self.assertEqual(self.send(char_mode='utf16'), (True, 'sent'))
        self.assertEqual(self.state['modes'], ['gbk', 'utf16'])
        self.state['modes'].clear()
        self.assertEqual(self.send(char_mode='utf16'), (True, 'sent'))
        self.assertEqual(self.state['modes'], ['utf16'])

    def test_verified_mode_survives_bridge_restart(self):
        with tempfile.TemporaryDirectory() as root:
            file = os.path.join(root, 'encoding.json')
            bg.configure({}, state_file=file)
            self.assertEqual(self.send(char_mode='utf16'), (True, 'sent'))
            bg._DETECTED_MODES.clear()
            bg._CONFIGURED_MODES.clear()
            bg._MODE_STATE_FILE = None
            bg.configure({}, state_file=file)
            self.state['modes'].clear()
            self.assertEqual(self.send(char_mode='utf16'), (True, 'sent'))
            self.assertEqual(self.state['modes'], ['gbk'])

    def test_second_failure_never_clicks_send_even_if_verify_disabled(self):
        self.state['never_matches'] = True
        self.assertEqual(self.send(verify=False), (False, 'input_dirty'))
        self.assertEqual(len(self.state['modes']), 2)
        self.assertEqual(self.state['sent'], [])

    def test_unreadable_after_typing_does_not_guess_encoding_or_send(self):
        self.state['unreadable'] = True
        self.assertEqual(self.send(), (False, 'input_dirty'))
        self.assertEqual(self.state['clears'], 0)
        self.assertEqual(self.state['sent'], [])

    def test_existing_draft_is_preserved(self):
        self.state['text'] = '用户正在编辑的草稿'
        self.assertEqual(self.send(), (False, 'input_not_empty'))
        self.assertEqual(self.state['modes'], [])
        self.assertEqual(self.state['clears'], 0)
        self.assertEqual(self.state['text'], '用户正在编辑的草稿')

    def test_clear_failure_stops_without_appending_another_encoding(self):
        self.state['clear_ok'] = False
        self.assertEqual(self.send(), (False, 'input_dirty'))
        self.assertEqual(self.state['modes'], ['utf16'])
        self.assertEqual(self.state['sent'], [])

    def test_chat_switch_during_clear_never_types_into_other_chat(self):
        self.state['switch_on_clear'] = True
        self.assertEqual(self.send(), (False, 'input_dirty'))
        self.assertEqual(self.state['modes'], ['utf16'])
        self.assertEqual(self.state['sent'], [])

    def test_gbk_skipped_emoji_is_compared_against_actual_payload(self):
        self.assertEqual(bg.send('鲸鲸😀', chat='测试群', hwnd=4242, char_mode='gbk'), (True, 'sent_partial'))
        self.assertEqual(self.state['sent'], ['鲸鲸'])
        self.assertEqual(self.state['clears'], 0)

    def test_correct_utf16_sends_emoji_without_switching(self):
        self.state['actual'] = 'utf16'
        self.assertEqual(bg.send('鲸鲸😀', chat='测试群', hwnd=4242), (True, 'sent'))
        self.assertEqual(self.state['sent'], ['鲸鲸😀'])
        self.assertEqual(self.state['modes'], ['utf16'])


class DirtyDraftPipelineTests(unittest.TestCase):
    def test_bridge_does_not_fall_back_or_disable_chat_after_dirty_draft(self):
        # 只提取发送闭包，避开 main 的真实微信连接；执行的仍是实际桥接代码。
        file = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'bridge', 'engine.py')
        with open(file, encoding='utf-8') as source:
            tree = ast.parse(source.read())
        functions = []
        for name in ('bg_send', 'send_text'):
            fn = next(n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef) and n.name == name)
            fn.body = [ast.copy_location(ast.Global(names=n.names), n) if isinstance(n, ast.Nonlocal) else n for n in fn.body]
            functions.append(fn)
        compiled = compile(ast.fix_missing_locations(ast.Module(body=functions, type_ignores=[])), file, 'exec')
        for reason in ('input_dirty', 'residue_left', 'input_not_empty'):
            with self.subTest(reason=reason):
                draft_error = type('DraftDirtyError', (RuntimeError,), {})
                fallback = Mock(side_effect=AssertionError('不能进入会抢前台的下一条发送通道'))
                env = dict(time=time, BG_SEND={'enabled': True},
                    BG_STATS=dict(disabled=False, cooldownUntil=0, tried=0),
                    _bg_hwnd=lambda: 4242, log=Mock(), log_error=Mock(),
                    DraftDirtyError=draft_error, ChatIdentityError=type('ChatIdentityError', (RuntimeError,), {}),
                    dead_chats=set(), fail_streak={}, account_send_allowed=lambda *a: True,
                    sticker_quarantine_allows=lambda *a: True, send_lock=nullcontext(),
                    _SendStateScope=lambda n: nullcontext(), STICKER_TEST_ON=False,
                    SEND_STATE={}, gui=None, WeChatGUI=fallback)
                module = SimpleNamespace(configure=Mock(), send=Mock(return_value=(False, reason)))
                with patch.dict(sys.modules, {'bg_sender': module}):
                    exec(compiled, env)
                    self.assertFalse(env['send_text']('测试正文', '测试群'))
                fallback.assert_not_called()
                self.assertEqual(env['dead_chats'], set())
                self.assertEqual(env['fail_streak'], {})


if __name__ == '__main__':
    unittest.main()
