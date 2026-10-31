"""Mock-only safety contract. Run: python -B tests/test_sticker_transport.py

Never imports the bridge (which has startup side effects), WeChatGUI, UIA,
win32gui, or a live HTTP client. Nested bridge functions are AST-extracted into
an entirely fake environment. Suitable for a node child-process test wrapper.
"""
import ast
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'bridge'))
import sticker_transport as transport


class FakeDB:
    account = 'test-account'
    wxid = 'self-user'

    def __init__(self):
        self.contacts = [{'username': 'peer', 'nick_name': 'Peer', 'remark': ''}]
        self.new = []
        self.baseline = [{'sort_seq': 10, 'type': '图片', 'sender_username': 'self-user'}]
        self.queries = []

    def search_contact(self, key):
        return [row for row in self.contacts if any(key in str(value) for value in row.values())]

    def get_messages(self, username, limit):
        self.queries.append(username)
        return self.baseline

    def get_new_messages(self, username, since_seq, limit):
        self.queries.append(username)
        return self.new


class FakeDesktop:
    def __init__(self):
        self.in_foreground = True
        self.has_focus = True
        self.input_value = ''
        self.clipboard_valid = True

    def foreground(self, hwnd):
        return self.in_foreground and hwnd == 100

    def focused(self, control, hwnd):
        return self.has_focus

    def value(self, control):
        return self.input_value

    def clipboard_matches(self, path):
        return self.clipboard_valid


class TransportTest(unittest.TestCase):
    def test_embeddable_python_imports_shipped_helper_without_script_directory(self):
        bridge = ROOT / 'bridge' / 'engine.py'
        tree = ast.parse(bridge.read_text(encoding='utf-8'))
        prefix = []
        for node in tree.body:
            if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == 'ROOT' for t in node.targets):
                break
            prefix.append(node)
        # Reproduce ._pth isolation and an empty import cache. Do not execute
        # config loading, main(), or import any GUI/WeChat/network dependencies.
        with patch.object(sys, 'path', [p for p in sys.path if os.path.abspath(p) != str(bridge.parent)]), \
                patch.dict(sys.modules), patch.dict(os.environ):
            sys.modules.pop('sticker_transport', None)
            scope = {'__file__': str(bridge), '__name__': 'bridge_import_prefix_test'}
            exec(compile(ast.Module(body=prefix, type_ignores=[]), str(bridge), 'exec'), scope)
            self.assertTrue(callable(scope['guarded_sticker_send']))
            self.assertEqual(sys.modules['sticker_transport'].__file__, str(bridge.parent / 'sticker_transport.py'))

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = self.temp.name
        self.path = str(Path(self.directory) / 'test.png')
        Path(self.path).write_bytes(b'mock-image-decoder-is-injected')
        self.db = FakeDB()
        self.desktop = FakeDesktop()
        self.control = SimpleNamespace(ControlTypeName='EditControl', AutomationId='root.chat_input_field', Name='Peer')
        self.uia = SimpleNamespace(_pinned_hwnd=100, _win=SimpleNamespace(NativeWindowHandle=100),
                                   current_chat=lambda: 'Peer', _chat_input=lambda: self.control)
        self.keys = []
        self.on_paste = lambda: None
        self.on_enter = lambda: setattr(self.db, 'new', [
            {'sort_seq': 11, 'type': '图片', 'sender_username': 'self-user'}])
        self.allow = True
        self.account = True
        self.active = True

        def key(code, **kwargs):
            self.keys.append(code)
            if code == 0x56:
                self.desktop.input_value = '\ufffc'
                self.on_paste()
            if code == 0x0D:
                self.on_enter()

        self.gui = SimpleNamespace(main_hwnd=100, _input=SimpleNamespace(key=key),
                                   copy_files_to_clipboard=Mock(return_value=True))

    def test_sole_window_accepted_when_configured_account_matches_database(self):
        # 现场故障：机器上有 3 个历史账号目录，现在只登一个号，网页里已经选好了小号，
        # 文字能发，表情包却一直 "target account window could not be verified"。
        allowed = transport.account_evidence_allowed(
            configured_account='wxid_test_account_0001',
            db_account='wxid_test_account_0001',
            reason='本机只登了一个号',
            explicit_pin=False,
            account_dirs=['a', 'b', 'c'],
        )
        self.assertTrue(allowed, '明确指定了账号且数据库就是这个号，应当放行')

    def test_sole_logged_in_account_is_enough_without_picking_one(self):
        # 现场故障：默认配置（网页里没选账号、机器上有 3 个历史账号目录），
        # 明明只登着一个号，表情包却一条也发不出去，还提示「去选一个账号」。
        allowed = transport.account_evidence_allowed(
            configured_account='', db_account='wxid_a', reason='本机只登了一个号',
            explicit_pin=False, account_dirs=['a', 'b', 'c'], visible_windows=1)
        self.assertTrue(allowed, '只登着一个微信时不需要手动选账号')

    def test_multiple_logged_in_accounts_still_need_explicit_choice(self):
        cases = [
            dict(configured_account='', db_account='wxid_a'),
            dict(configured_account='wxid_a', db_account=''),
            dict(configured_account='wxid_a', db_account='wxid_b'),
        ]
        for case in cases:
            self.assertFalse(transport.account_evidence_allowed(
                reason='本机只登了一个号', explicit_pin=False, account_dirs=['a', 'b'],
                visible_windows=2, **case), case)
        self.assertTrue(transport.account_evidence_allowed(
            reason='本机只登了一个号', explicit_pin=False, account_dirs=['a', 'b'],
            visible_windows=2, configured_account='wxid_a', db_account='wxid_a'),
            '多开时明确选了账号且数据库对得上就放行')
        self.assertTrue(transport.account_evidence_allowed(
            reason='本机只登了一个号', explicit_pin=True, account_dirs=['a', 'b'],
            visible_windows=3, configured_account='', db_account='wxid_a'),
            '手动钉窗口时总会放行')

    def test_sole_window_refused_when_account_is_ambiguous(self):
        cases = [
            dict(configured_account='', db_account='wxid_a', reason='本机只登了一个号'),
            dict(configured_account='wxid_a', db_account='', reason='本机只登了一个号'),
            dict(configured_account='wxid_a', db_account='wxid_b', reason='本机只登了一个号'),
        ]
        for case in cases:
            self.assertFalse(transport.account_evidence_allowed(
                explicit_pin=False, account_dirs=['a', 'b'], **case), case)
            self.assertEqual(transport.account_evidence_allowed(
                explicit_pin=True, account_dirs=['a', 'b'], **case),
                not case['configured_account'] or case['configured_account'] == case['db_account'],
                '钉窗口也不能绕过明确的账号冲突')

    def test_account_evidence_accepts_other_reasons_and_single_account(self):
        for reason, dirs in (('命中最近会话 3 条', ['a', 'b']), ('本机只登了一个号', ['a'])):
            self.assertTrue(transport.account_evidence_allowed(
                configured_account='', db_account='wxid_a', reason=reason,
                explicit_pin=False, account_dirs=dirs), reason)

    def send(self, **overrides):
        arguments = dict(gui=self.gui, uia=self.uia, hwnd=100, aliases={'Peer'}, path=self.path,
                         root=self.directory, db=self.db, username='peer', gate=lambda: self.allow,
                         account_valid=lambda: self.account, activity_allowed=lambda: self.active,
                         desktop=self.desktop, image_check=lambda path, expected: None,
                         sleep=lambda delay: None, confirm_timeout=0)
        arguments.update(overrides)
        return transport.guarded_send(**arguments)

    def test_off_does_not_touch_db_files_clipboard_or_keys(self):
        self.allow = False
        self.db.get_messages = Mock(side_effect=AssertionError('DB touched while off'))
        with patch.object(transport, 'validate_path', side_effect=AssertionError('file touched while off')):
            self.assertEqual(self.send()['status'], 'cancelled')
        self.gui.copy_files_to_clipboard.assert_not_called()
        self.assertEqual(self.keys, [])

    def test_confirmed_only_after_one_paste_one_enter_and_outgoing_delta(self):
        self.assertEqual(self.send(), {'status': 'confirmed', 'error': ''})
        self.assertEqual(self.keys, [0x56, 0x0D])
        self.assertEqual(set(self.db.queries), {'peer'})

    def test_initial_guards_never_paste(self):
        cases = [('account', False), ('active', False)]
        for name, value in cases:
            with self.subTest(name=name):
                setattr(self, name, value)
                self.assertEqual(self.send()['status'], 'failed')
                self.assertEqual(self.keys, [])
                setattr(self, name, True)
        for mutate in [lambda: setattr(self.desktop, 'in_foreground', False),
                       lambda: setattr(self.desktop, 'has_focus', False),
                       lambda: setattr(self.uia, '_pinned_hwnd', 101),
                       lambda: setattr(self.uia, 'current_chat', lambda: 'Wrong chat'),
                       lambda: setattr(self.uia, '_chat_input', lambda: None)]:
            self.setUp()
            mutate()
            self.assertEqual(self.send()['status'], 'failed')
            self.assertEqual(self.keys, [])

    def test_current_chat_cache_cannot_override_wrong_focused_control_title(self):
        self.control.Name = 'Wrong chat'
        self.assertEqual(self.send()['status'], 'failed')
        self.assertEqual(self.keys, [])

    def test_literal_voice_hint_named_contact_collision_rejects_alias(self):
        self.db.contacts.append({'username': 'other', 'nick_name': 'Peer语音输入', 'remark': ''})
        _, aliases = transport.resolve_target(self.db, 'Peer', 'peer')
        self.assertNotIn('Peer', aliases)

    def test_unknown_input_is_not_blank(self):
        self.assertFalse(transport._is_blank(None))
        self.assertFalse(transport._is_blank(0))
        self.assertTrue(transport._is_blank('\n  \r\n'))
        self.desktop.value = lambda control: None
        self.assertEqual(self.send()['status'], 'failed')
        self.assertEqual(self.keys, [])

    def test_distinct_internal_space_or_case_names_never_match(self):
        self.assertFalse(transport.alias_match('AB', {'A B'}))
        self.assertFalse(transport.alias_match('peer', {'Peer'}))
        self.assertTrue(transport.alias_match(' Peer\n', {'Peer'}))
        self.uia.current_chat = lambda: 'AB'
        self.assertEqual(self.send(aliases={'A B'})['status'], 'failed')
        self.assertEqual(self.keys, [])

    def test_filename_in_new_text_cannot_fake_delivery(self):
        marker = {'md5': 'a' * 32, 'name': 'a.gif'}
        for content in ['找不到a.gif', 'a' * 32, '<msg><title>a.gif</title></msg>']:
            self.db.new = [{'sort_seq': 11, 'type': '文字', 'content': content,
                            'sender_username': 'self-user'}]
            out = transport.confirm_delivery(self.db, 'peer', 10, transport.db_identity(self.db),
                                             lambda: True, timeout=0, marker=marker)
            self.assertEqual(out['status'], 'unconfirmed')

    def test_file_card_needs_structured_exact_fingerprint(self):
        marker = {'md5': 'a' * 32, 'name': 'a.gif'}
        for content in ['<msg><appmsg><title>a.gif</title></appmsg></msg>',
                        '<msg><appmsg><md5>' + 'a' * 32 + '</md5></appmsg></msg>']:
            self.db.new = [{'sort_seq': 11, 'type': '文件/链接/卡片', 'content': content,
                            'sender_username': 'self-user'}]
            self.assertEqual(transport.confirm_delivery(self.db, 'peer', 10, transport.db_identity(self.db),
                             lambda: True, timeout=0, marker=marker)['status'], 'confirmed')
        for content in ['a.gif', '<msg><title>not-a.gif</title></msg>', '<msg><md5>wrong</md5></msg>']:
            self.db.new[0]['content'] = content
            self.assertEqual(transport.confirm_delivery(self.db, 'peer', 10, transport.db_identity(self.db),
                             lambda: True, timeout=0, marker=marker)['status'], 'unconfirmed')

    def test_no_window_and_configured_account_mismatch_are_rejected(self):
        base = dict(configured_account='', db_account='wxid_a', reason='本机只登了一个号',
                    explicit_pin=False, account_dirs=['a', 'b'])
        for count in [0, -1, 'oops']:
            self.assertFalse(transport.account_evidence_allowed(**base, visible_windows=count))
        base['configured_account'] = 'wxid_b'
        self.assertFalse(transport.account_evidence_allowed(**base, visible_windows=1))

    def test_existing_text_draft_is_not_overwritten(self):
        self.desktop.input_value = 'private draft'
        self.assertEqual(self.send()['status'], 'failed')
        self.assertEqual(self.keys, [])

    def test_whitespace_only_input_counts_as_empty(self):
        # 现场真凶：微信输入框「空」时 UIA 读到的是 '\n'，旧代码按 != '' 判断，
        # 于是永远认为「有草稿」，私聊一张也发不出去。
        self.desktop.value = lambda control: '\n\ufffc\n' if 0x56 in self.keys else '\n'
        self.assertEqual(self.send()['status'], 'confirmed')
        self.assertEqual(self.keys[:2], [0x56, 0x0D])

    def test_attachment_marker_with_surrounding_newlines_is_accepted(self):
        def key(code, **kwargs):
            self.keys.append(code)
            if code == 0x56:
                self.desktop.input_value = '\ufffc'
            if code == 0x0D:
                self.on_enter()

        self.gui._input = SimpleNamespace(key=key)
        self.desktop.value = lambda control: '\n\ufffc\n' if 0x56 in self.keys else '\n'
        self.assertEqual(self.send()['status'], 'confirmed')

    def test_off_after_clipboard_preparation_prevents_paste(self):
        self.gui.copy_files_to_clipboard.side_effect = lambda paths: setattr(self, 'allow', False) or True
        self.assertEqual(self.send()['status'], 'cancelled')
        self.assertEqual(self.keys, [])

    def test_changed_clipboard_prevents_paste(self):
        self.desktop.clipboard_valid = False
        self.assertEqual(self.send()['status'], 'cancelled')
        self.assertEqual(self.keys, [])

    def test_off_after_paste_no_enter_no_retry(self):
        self.on_paste = lambda: setattr(self, 'allow', False)
        outcome = self.send()
        self.assertEqual(outcome['status'], 'unconfirmed')
        self.assertIn('clear draft manually', outcome['error'])
        self.assertTrue(outcome['draft_may_remain'])
        self.assertEqual(self.keys, [0x56])

    def test_wrong_chat_after_paste_no_enter(self):
        self.on_paste = lambda: setattr(self.uia, 'current_chat', lambda: 'Wrong chat')
        self.assertEqual(self.send()['status'], 'unconfirmed')
        self.assertEqual(self.keys, [0x56])

    def test_unsupported_draft_never_presses_enter(self):
        self.on_paste = lambda: setattr(self.desktop, 'input_value', '')
        self.assertEqual(self.send()['status'], 'unconfirmed')
        self.assertEqual(self.keys, [0x56])

    def test_partial_exception_does_not_retry(self):
        def uncertain():
            raise RuntimeError('fake failure after action')
        self.on_enter = uncertain
        self.assertEqual(self.send()['status'], 'unconfirmed')
        self.assertEqual(self.keys, [0x56, 0x0D])

    def test_incoming_old_or_raw_sender_id_two_do_not_confirm(self):
        for message in [
            {'sort_seq': 11, 'type': '图片', 'sender_username': 'peer'},
            {'sort_seq': 10, 'type': '图片', 'sender_username': 'self-user'},
            {'sort_seq': 11, 'type': '图片', 'sender_id': 2},
            {'sort_seq': 11, 'type': '文字', 'sender_username': 'self-user'},
        ]:
            with self.subTest(message=message):
                self.desktop.input_value = ''
                self.on_enter = lambda m=message: setattr(self.db, 'new', [m])
                self.assertEqual(self.send()['status'], 'unconfirmed')

    def test_database_account_change_never_confirms(self):
        self.on_enter = lambda: setattr(self.db, 'account', 'other-account')
        self.assertEqual(self.send()['status'], 'unconfirmed')

    def test_ambiguous_outgoing_media_never_confirms(self):
        self.on_enter = lambda: setattr(self.db, 'new', [
            {'sort_seq': n, 'type': '图片', 'sender_username': 'self-user'} for n in (11, 12)])
        self.assertEqual(self.send()['status'], 'unconfirmed')

    def test_db_error_is_not_success(self):
        self.db.get_new_messages = Mock(side_effect=RuntimeError('fake DB unavailable'))
        self.assertEqual(self.send()['status'], 'unconfirmed')

    def test_shard_local_sender_resolution(self):
        self.db.sender_username = lambda shard, sender: 'self-user' if (shard, sender) == ('part-1', 57) else 'peer'
        self.on_enter = lambda: setattr(self.db, 'new', [
            {'sort_seq': 11, 'type': '表情', 'sender_id': 57, 'shard': 'part-1'}])
        self.assertEqual(self.send()['status'], 'confirmed')

    def test_outside_root_nonimage_and_oversize_rejected(self):
        outside = str(Path(self.directory).parent / 'outside.png')
        self.assertEqual(self.send(path=outside)['status'], 'failed')
        invalid = Path(self.directory) / 'document.txt'
        invalid.write_text('not an image')
        self.assertEqual(self.send(path=str(invalid))['status'], 'failed')
        Path(self.path).write_bytes(b'X' * (transport.MAX_BYTES + 1))
        self.assertEqual(self.send()['status'], 'failed')
        self.assertEqual(self.keys, [])

    def test_short_name_root_is_accepted_like_any_normal_path(self):
        # 现场真凶（CI 上每张表情包都发不出去）：Windows 的 8.3 短名路径
        # （用户名那种带 ~1 的形式）经 realpath 会展开成长名，两个字符串因此不同，
        # 旧代码要求「abspath 必须等于 realpath」，于是合法路径被判成链接。
        # 短名不是链接，只有真正的软链接/重解析点才该拒绝。
        short_root = self.directory
        long_dir = tempfile.TemporaryDirectory()
        self.addCleanup(long_dir.cleanup)
        # 两个目标都必须用 realpath 展开后的前缀，否则「同一个目录」在假
        # realpath 下反而对不齐——CI 的 TEMP 本身就在短名路径里。
        long_root = os.path.realpath(long_dir.name)
        long_file = os.path.join(long_root, 'test.png')
        Path(long_file).write_bytes(Path(self.path).read_bytes())
        mapping = {short_root: long_root, self.path: long_file}
        realpath = os.path.realpath

        def fake_realpath(value):
            key = os.path.abspath(os.fspath(value))
            return mapping.get(key, realpath(key))

        with patch.object(transport.os.path, 'realpath', side_effect=fake_realpath):
            self.assertEqual(self.send()['status'], 'confirmed')
            approved, fingerprint = transport.validate_path(
                self.path, short_root, lambda path, expected: None)
        self.assertEqual(approved, long_file, '应当返回展开后的真实路径供剪贴板使用')
        self.assertEqual(fingerprint[0], Path(long_file).stat().st_size)

    def test_image_decoder_failure_never_pastes(self):
        def reject(path, expected):
            raise ValueError('invalid image')
        self.assertEqual(self.send(image_check=reject)['status'], 'failed')
        self.assertEqual(self.keys, [])

    def test_exact_target_aliases_and_ambiguous_names(self):
        self.assertEqual(transport.resolve_target(self.db, 'Peer'), ('peer', frozenset({'peer', 'Peer'})))
        self.db.contacts.append({'username': 'other', 'nick_name': 'Peer', 'remark': ''})
        with self.assertRaises(ValueError):
            transport.resolve_target(self.db, 'Peer')
        canonical, aliases = transport.resolve_target(self.db, 'Peer', 'peer')
        self.assertEqual(canonical, 'peer')
        self.assertNotIn('Peer', aliases)
        self.assertNotIn('Pee', aliases)

    def test_truncated_contact_search_fails_closed(self):
        self.db.search_contact = lambda key: [self.db.contacts[0]] * 50
        with self.assertRaises(ValueError):
            transport.resolve_target(self.db, 'Peer')


BRIDGE = ROOT / 'bridge' / 'engine.py'


def bridge_functions(names, environment):
    source = ast.parse(BRIDGE.read_text(encoding='utf-8'))
    definitions = [node for node in ast.walk(source)
                   if isinstance(node, ast.FunctionDef) and node.name in names]
    if {node.name for node in definitions} != set(names):
        raise AssertionError('bridge function not found')
    # Test closures are represented by the fake globals dictionary, never by a
    # real main()/bridge instance. Preserve assignment semantics for gui.
    class ClosureGlobals(ast.NodeTransformer):
        def visit_Nonlocal(self, node):
            return ast.copy_location(ast.Global(names=node.names), node)
    definitions = [ClosureGlobals().visit(node) for node in definitions]
    exec(compile(ast.fix_missing_locations(ast.Module(body=definitions, type_ignores=[])),
                 '<mock-only bridge functions>', 'exec'), environment)
    return environment


class BridgeContractTest(unittest.TestCase):
    def setUp(self):
        self.cfg = {'features': {'stickers': True}, 'wechat': {}}
        self.http = SimpleNamespace(get=Mock(), post=Mock())
        self.log = Mock()
        self.env = dict(STICKER_TEST_ON=True, ACCOUNT_WANTED='', CONFIG_PATH='unused-fake-config',
                        read_enabled_config=lambda path: self.cfg,
                        LOCAL_HTTP=self.http, sticker_base='http://fake.invalid',
                        sticker_headers={'x-bot-token': 'test-only'}, sticker_result=transport.result,
                        log=self.log, log_throttled=self.log,
                        time=SimpleNamespace(time=lambda: 1, sleep=lambda delay: None))
        bridge_functions({'sticker_config_now', 'sticker_gate', 'claim_and_send_sticker'}, self.env)
        self.item = {'id': 'one-shot', 'generation': 'g1', 'path': 'test.png', 'chat': 'Peer',
                     'chatUsername': 'peer', 'status': 'sending'}
        self.http.get.return_value = SimpleNamespace(status_code=200, json=lambda: {
            'ok': True, 'enabled': True, 'generation': 'g1',
            'jobs': [{'id': 'one-shot', 'status': 'sending'}]})
        self.http.post.return_value = SimpleNamespace(status_code=200, json=lambda: {'ok': True, 'item': self.item})
        self.send = Mock(return_value=transport.result('unconfirmed', 'no database evidence'))
        self.env['send_sticker'] = self.send

    def test_off_silent_no_http_no_disk_or_send(self):
        self.env['STICKER_TEST_ON'] = False
        self.env['read_enabled_config'] = Mock(side_effect=AssertionError('disk read while cached off'))
        outcome = self.env['claim_and_send_sticker'](self.item)
        self.assertEqual(outcome['status'], 'cancelled')
        self.http.get.assert_not_called()
        self.http.post.assert_not_called()
        self.send.assert_not_called()
        self.log.assert_not_called()

    def test_fresh_disk_off_blocks_stale_cached_flag(self):
        self.cfg = None
        self.assertEqual(self.env['claim_and_send_sticker'](self.item)['status'], 'cancelled')
        self.assertFalse(self.env['STICKER_TEST_ON'])
        self.http.get.assert_not_called()
        self.send.assert_not_called()

    def test_off_on_old_generation_rejected(self):
        self.http.get.return_value.json = lambda: {'ok': True, 'enabled': True, 'generation': 'g2'}
        self.assertEqual(self.env['claim_and_send_sticker'](self.item)['status'], 'cancelled')
        self.http.post.assert_not_called()
        self.send.assert_not_called()

    def test_expired_or_missing_sending_job_blocks_action_gate(self):
        self.assertTrue(self.env['sticker_gate']('g1', 'one-shot'))
        self.assertFalse(self.env['sticker_gate']('g1', 'missing-job'))
        self.http.get.return_value.json = lambda: {
            'ok': True, 'enabled': True, 'generation': 'g1',
            'jobs': [{'id': 'one-shot', 'status': 'unconfirmed'}]}
        self.assertFalse(self.env['sticker_gate']('g1', 'one-shot'))

    def test_status_failure_never_claims_or_sends(self):
        self.http.get.return_value.status_code = 404
        self.assertFalse(self.env['sticker_gate']('g1'))
        self.env['claim_and_send_sticker'](self.item)
        self.http.post.assert_not_called()
        self.send.assert_not_called()

    def test_claim_failure_no_send_no_retry(self):
        self.http.post.return_value.status_code = 409
        self.assertEqual(self.env['claim_and_send_sticker'](self.item)['status'], 'failed')
        self.assertEqual(self.http.post.call_count, 1)
        self.send.assert_not_called()

    def test_structured_ack_not_truthy_success(self):
        self.env['claim_and_send_sticker'](self.item)
        self.send.assert_called_once()
        posts = self.http.post.call_args_list
        self.assertEqual(len(posts), 2)
        self.assertTrue(posts[0].args[0].endswith('/claim'))
        self.assertEqual(posts[1].kwargs['json'], {
            'id': 'one-shot', 'status': 'unconfirmed', 'error': 'no database evidence'})
        self.assertEqual(posts[0].kwargs['headers']['x-bot-token'], 'test-only')

    def test_ack_is_retried_so_console_does_not_stick_on_sending(self):
        # 现场问题：服务端正在生成长回复时 ack 超时，旧代码 except: pass 吞掉，
        # 控制台就永远停在「尝试发送中」。现在要重试，且不能影响已发出的结果。
        attempts = {'n': 0}
        real_post = self.http.post

        def flaky(url, *args, **kwargs):
            if url.endswith('/ack'):
                attempts['n'] += 1
                if attempts['n'] == 1:
                    raise TimeoutError('server busy')
            return real_post(url, *args, **kwargs)

        self.http.post = Mock(side_effect=flaky)
        outcome = self.env['claim_and_send_sticker'](self.item)
        self.assertEqual(outcome['status'], 'unconfirmed')
        self.assertEqual(attempts['n'], 2, '第一次失败后要再试一次')
        self.assertEqual(self.send.call_count, 1, '绝不重发图片')

    def test_ack_409_means_already_handled_and_is_not_retried(self):
        attempts = {'n': 0}
        real_post = self.http.post

        def conflict(url, *args, **kwargs):
            if url.endswith('/ack'):
                attempts['n'] += 1
                return SimpleNamespace(status_code=409, json=lambda: {'ok': False})
            return real_post(url, *args, **kwargs)

        self.http.post = Mock(side_effect=conflict)
        self.env['claim_and_send_sticker'](self.item)
        self.assertEqual(attempts['n'], 1)

    def test_auto_claim_checks_canonical_not_different_display_title(self):
        self.item['chat'] = 'peer'
        outcome = self.env['claim_and_send_sticker'](self.item, expected_chat='Peer', expected_username='peer')
        self.assertEqual(outcome['status'], 'unconfirmed')
        self.send.assert_called_once()

    def test_auto_claim_rejects_wrong_canonical_target(self):
        self.env['claim_and_send_sticker'](self.item, expected_chat='Peer', expected_username='other')
        self.send.assert_not_called()

    def test_pending_account_change_blocks_send_before_restart(self):
        self.cfg['wechat']['account'] = 'changed-account'
        self.assertEqual(self.env['claim_and_send_sticker'](self.item)['status'], 'cancelled')
        self.send.assert_not_called()

    def send_environment(self):
        self.env.update(send_lock=threading.Lock(), gui_lock=threading.Lock(),
                        sticker_activity_allowed=Mock(return_value=True),
                        sticker_quarantine_allows=Mock(return_value=True), sticker_draft_quarantine={},
                        sticker_account_evidence_allowed=Mock(return_value=True),
                        wechat_main_window_count=Mock(return_value=1),
                        account_send_allowed=Mock(return_value=True), ACCOUNT={'verified': True, 'hwnd': 100},
                        wechat_window_alive=Mock(return_value=True),
                        WindowsDesktop=Mock(return_value=FakeDesktop()),
                        gui=SimpleNamespace(main_hwnd=100, use_window=Mock(return_value=True),
                                            _uia=SimpleNamespace(current_chat=lambda: 'Peer',
                                                                 open_chat=Mock(return_value=True))),
                        resolve_sticker_target=Mock(return_value=('peer', {'Peer'})),
                        sticker_alias_match=transport.alias_match,
                        force_foreground=Mock(return_value=True),
                        snapshot_win_state=Mock(return_value={'hwnd': 100, 'iconic': False, 'fg': 0}),
                        restore_win_state=Mock(), log_throttled=Mock(),
                        guarded_sticker_send=Mock(return_value=transport.result('confirmed')),
                        _compat_mod=lambda: SimpleNamespace(pinned_window=lambda: 100),
                        ROOT=str(ROOT), os=os, db=FakeDB(), SEND_STATE={'active': False, 'start': 0},
                        time=SimpleNamespace(time=lambda: 1, sleep=lambda delay: None))
        bridge_functions({'send_sticker'}, self.env)
        return self.env

    def test_bridge_account_rejection_never_binds_or_transports(self):
        env = self.send_environment()
        env['account_send_allowed'].return_value = False
        self.assertEqual(env['send_sticker']('fake.png', 'Peer', 'peer', 'g1', 'one-shot')['status'], 'failed')
        env['gui'].use_window.assert_not_called()
        env['guarded_sticker_send'].assert_not_called()

    def test_bridge_brings_wechat_forward_instead_of_refusing(self):
        # 现场回归：用户点发送时微信不在前台，以前直接 "open the target account window
        # in the foreground first" 失败。现在应当短暂抬到前台、发送、再还原窗口。
        env = self.send_environment()
        desktop = FakeDesktop()
        desktop.in_foreground = False
        env['WindowsDesktop'] = Mock(return_value=desktop)
        env['force_foreground'].side_effect = lambda hwnd: setattr(desktop, 'in_foreground', True) or True
        outcome = env['send_sticker']('fake.png', 'Peer', 'peer', 'g1', 'one-shot')
        self.assertEqual(outcome['status'], 'confirmed')
        env['force_foreground'].assert_called_once_with(100)
        env['snapshot_win_state'].assert_called_once()
        env['restore_win_state'].assert_called_once()
        env['guarded_sticker_send'].assert_called_once()

    def test_bridge_fails_when_window_cannot_be_brought_forward(self):
        env = self.send_environment()
        desktop = FakeDesktop()
        desktop.in_foreground = False
        env['WindowsDesktop'] = Mock(return_value=desktop)
        env['force_foreground'].return_value = False
        self.assertEqual(env['send_sticker']('fake.png', 'Peer', 'peer', 'g1', 'one-shot')['status'], 'failed')
        env['guarded_sticker_send'].assert_not_called()

    def test_bridge_opens_exact_target_then_verifies_title(self):
        env = self.send_environment()
        chats = {'current': 'Some other chat'}
        env['gui']._uia = SimpleNamespace(
            current_chat=lambda: chats['current'],
            open_chat=Mock(side_effect=lambda keys: chats.update(current='Peer') or True))
        self.assertEqual(env['send_sticker']('fake.png', 'Peer', 'peer', 'g1', 'one-shot')['status'], 'confirmed')
        env['gui']._uia.open_chat.assert_called_once()

    def test_bridge_never_sends_when_open_chat_lands_on_wrong_title(self):
        env = self.send_environment()
        env['gui']._uia = SimpleNamespace(
            current_chat=lambda: 'Wrong chat', open_chat=Mock(return_value=True))
        self.assertEqual(env['send_sticker']('fake.png', 'Peer', 'peer', 'g1', 'one-shot')['status'], 'failed')
        env['guarded_sticker_send'].assert_not_called()

    def test_bridge_bind_failure_never_transports(self):
        env = self.send_environment()
        env['gui'].use_window.return_value = False
        self.assertEqual(env['send_sticker']('fake.png', 'Peer', 'peer', 'g1', 'one-shot')['status'], 'failed')
        env['gui'].use_window.assert_called_once_with(100)
        env['guarded_sticker_send'].assert_not_called()

    def test_bridge_rechecks_switch_after_lock_wait(self):
        env = self.send_environment()
        outer = self
        class WaitingLock:
            def __enter__(self):
                outer.cfg = None
            def __exit__(self, *args):
                return False
        env['send_lock'] = WaitingLock()
        self.assertEqual(env['send_sticker']('fake.png', 'Peer', 'peer', 'g1', 'one-shot')['status'], 'cancelled')
        env['account_send_allowed'].assert_not_called()
        env['gui'].use_window.assert_not_called()
        env['guarded_sticker_send'].assert_not_called()

    def test_bridge_watchdog_clears_on_transport_exception_without_retry(self):
        env = self.send_environment()
        env['guarded_sticker_send'].side_effect = RuntimeError('fake partial transport error')
        self.assertEqual(env['send_sticker']('fake.png', 'Peer', 'peer', 'g1', 'one-shot')['status'], 'unconfirmed')
        env['guarded_sticker_send'].assert_called_once()
        self.assertFalse(env['SEND_STATE']['active'])

    def quarantine_environment(self, observed=False, value='\ufffc'):
        env = self.send_environment()
        pattern = SimpleNamespace(Value=value)
        control = SimpleNamespace(Name='Peer', ControlTypeName='EditControl',
                                  AutomationId='root.chat_input_field', GetValuePattern=lambda: pattern)
        uia = SimpleNamespace(_pinned_hwnd=100, _win=SimpleNamespace(NativeWindowHandle=100),
                              current_chat=lambda: 'Peer', _chat_input=lambda: control)
        env['gui']._uia = uia
        env.update(quarantined_input_value=transport.quarantined_input_value,
                   sticker_input_is_blank=transport._is_blank, log_throttled=Mock(),
                   sticker_draft_quarantine={'peer': {'hwnd': 100, 'aliases': {'Peer'},
                                                      'draft_observed': observed}},
                   acct_dirs=['test-account'], acct='test-account', WINDOW_HWND=0, dead_chats=set(),
                   sticker_account_evidence_ok=transport.account_evidence_allowed,
                   group_is_alive=lambda username: True, AWAY={'on': False}, away_active=lambda: False,
                   game_running=lambda: False, foreground_is_fullscreen=lambda: False)
        bridge_functions({'sticker_quarantine_allows', 'sticker_account_evidence_allowed', 'send_text', 'send_at'}, env)
        return env, pattern, uia

    def test_unconfirmed_transport_quarantines_canonical_target(self):
        env = self.send_environment()
        env['guarded_sticker_send'].return_value = transport.result(
            'unconfirmed', 'draft uncertain', draft_may_remain=True, draft_observed=True)
        outcome = env['send_sticker']('fake.png', 'Peer', 'peer', 'g1', 'one-shot')
        self.assertEqual(outcome['status'], 'unconfirmed')
        self.assertEqual(env['sticker_draft_quarantine']['peer'], {
            'hwnd': 100, 'aliases': {'Peer'}, 'draft_observed': True})

    def test_latent_draft_blocks_later_text_at_and_sticker_even_feature_off(self):
        env, pattern, uia = self.quarantine_environment()
        env['STICKER_TEST_ON'] = False
        self.assertFalse(env['send_text']('text must not send', 'Peer', 'peer'))
        self.assertFalse(env['send_at']('member', 'text must not send', 'Peer', 'peer'))
        env['gui'].use_window.assert_not_called()
        self.assertTrue(env['sticker_draft_quarantine']['peer']['draft_observed'])
        env['STICKER_TEST_ON'] = True
        self.assertEqual(env['send_sticker']('fake.png', 'Peer', 'peer', 'g1', 'one-shot')['status'], 'failed')
        env['guarded_sticker_send'].assert_not_called()
        env['log_throttled'].assert_called()

    def test_quarantine_requires_observed_nonempty_then_exact_target_empty(self):
        env, pattern, uia = self.quarantine_environment(observed=False, value='')
        self.assertFalse(env['sticker_quarantine_allows']('peer', 'Peer'))
        pattern.Value = '\ufffc'
        self.assertFalse(env['sticker_quarantine_allows']('peer', 'Peer'))
        pattern.Value = ''  # operator manually cleared it; no automation keys
        self.assertTrue(env['sticker_quarantine_allows']('peer', 'Peer'))
        self.assertNotIn('peer', env['sticker_draft_quarantine'])
        env['gui'].use_window.assert_not_called()

    def test_manually_cleared_newline_releases_quarantine_without_keys(self):
        env, pattern, _ = self.quarantine_environment(observed=True, value='\n')
        self.assertTrue(env['sticker_quarantine_allows']('peer', 'Peer'))
        self.assertNotIn('peer', env['sticker_draft_quarantine'])
        env['gui'].use_window.assert_not_called()

    def test_quarantine_wrong_target_or_unavailable_value_never_releases(self):
        env, pattern, uia = self.quarantine_environment(observed=True, value='')
        uia.current_chat = lambda: 'Wrong chat'
        self.assertFalse(env['sticker_quarantine_allows']('peer', 'Peer'))
        self.assertIn('peer', env['sticker_draft_quarantine'])
        uia.current_chat = lambda: 'Peer'
        uia._chat_input = lambda: None
        self.assertFalse(env['sticker_quarantine_allows']('peer', 'Peer'))
        self.assertIn('peer', env['sticker_draft_quarantine'])

    def test_quarantine_does_not_block_unrelated_canonical_chat(self):
        env, _, _ = self.quarantine_environment()
        self.assertTrue(env['sticker_quarantine_allows']('other-peer', 'Other peer'))
        self.assertIn('peer', env['sticker_draft_quarantine'])

    def test_sole_visible_window_needs_the_configured_account(self):
        # 现场回归 1：只登着一个号时，不需要在网页里选账号，表情包也应该能发。
        env, _, _ = self.quarantine_environment()
        env['ACCOUNT']['why'] = '本机只登了一个号'
        env['acct_dirs'] = ['test-account', 'another-account']
        env['ACCOUNT_WANTED'] = ''
        env['wechat_main_window_count'].return_value = 1
        self.assertTrue(env['sticker_account_evidence_allowed'](), '只登一个号时默认就能发')

        # 现场回归 2：真·多开（两个号同时登着）时才要求明确选账号。
        env['wechat_main_window_count'].return_value = 2
        self.assertFalse(env['sticker_account_evidence_allowed'](), '多开且没指定账号时不猜')
        env['ACCOUNT_WANTED'] = 'test-account'  # 与 db.account 一致
        self.assertTrue(env['sticker_account_evidence_allowed'](), '指定了正确账号应放行')
        env['ACCOUNT_WANTED'] = 'another-account'
        self.assertFalse(env['sticker_account_evidence_allowed'](), '指定账号与数据库不一致要拒绝')
        env['ACCOUNT_WANTED'] = 'test-account'
        env['WINDOW_HWND'] = 100  # 手动钉窗口：直接放行
        self.assertTrue(env['sticker_account_evidence_allowed']())

    def test_settings_and_detached_windows_are_not_extra_accounts(self):
        # 现场回归：设置窗、群公告/独立聊天窗也是 QWindowIcon，标题却不是「微信」。
        # 只按类名计数会把「设置」当成第二个号，私聊表情包全被账号闸拒绝。
        windows = {
            100: ('Qt51514QWindowIcon', '微信'),
            101: ('Qt51514QWindowIcon', '设置'),
            102: ('Qt51514QWindowIcon', 'Banan1ce'),
            103: ('Chrome_WidgetWin_1', '群公告-某个群'),
        }
        fake_gui = SimpleNamespace(GetClassName=lambda h: windows[int(h)][0],
                                   GetWindowText=lambda h: windows[int(h)][1])
        fake_driver = SimpleNamespace(WeChatUIA=lambda: SimpleNamespace(_wechat_hwnds=lambda: list(windows)))
        env = bridge_functions({'wechat_main_window_count'}, {})
        with patch.dict(sys.modules, {'win32gui': fake_gui,
                                      'wechatauto.uia_driver': fake_driver}):
            self.assertEqual(env['wechat_main_window_count'](), 1, '只有一个标题为「微信」的主窗')
            windows[104] = ('mmui::MainWindow', '微信')
            self.assertEqual(env['wechat_main_window_count'](), 2, '真的登了两个号才计为 2')

    def test_entire_bridge_syntax_compiles_without_executing_it(self):
        compile(BRIDGE.read_text(encoding='utf-8'), str(BRIDGE), 'exec')

    def test_dormant_worker_always_started_not_gated_at_construction(self):
        source = ast.parse(BRIDGE.read_text(encoding='utf-8'))
        parents = {child: node for node in ast.walk(source) for child in ast.iter_child_nodes(node)}
        starts = [node for node in ast.walk(source) if isinstance(node, ast.Call)
                  and isinstance(node.func, ast.Attribute) and node.func.attr == 'Thread'
                  and any(k.arg == 'target' and isinstance(k.value, ast.Name)
                          and k.value.id == 'sticker_test_loop' for k in node.keywords)]
        self.assertEqual(len(starts), 1)
        node = starts[0]
        while node in parents:
            node = parents[node]
            self.assertFalse(isinstance(node, ast.If), 'worker construction must not be startup-switch conditional')

    def test_off_worker_no_http_or_logging(self):
        class StopLoop(BaseException):
            pass
        self.env.update(STICKER_TEST_ON=False,
                        time=SimpleNamespace(sleep=Mock(side_effect=StopLoop())))
        bridge_functions({'sticker_test_loop'}, self.env)
        with self.assertRaises(StopLoop):
            self.env['sticker_test_loop']()
        self.http.get.assert_not_called()
        self.http.post.assert_not_called()
        self.log.assert_not_called()

    def test_fresh_config_parser_defaults_off_for_missing_or_malformed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'fake-config.json'
            self.assertIsNone(transport.read_enabled_config(path))
            for content in ['{}', '{', '{"features":{"stickers":false}}', '{"features":{"stickers":"false"}}']:
                path.write_text(content, encoding='utf-8')
                self.assertIsNone(transport.read_enabled_config(path))
            path.write_text('{"features":{"stickers":true}}', encoding='utf-8')
            self.assertIsNotNone(transport.read_enabled_config(path))


if __name__ == '__main__':
    unittest.main(verbosity=2)
