# -*- coding: utf-8 -*-
"""Bridge runtime mixin: StickerMixin."""
import engine as G


class StickerMixin:

    def sticker_quarantine_allows(self, username, shown='', gui_locked=False):
        requested = str(username or '').strip()
        matches = [(key, entry) for key, entry in self.sticker_draft_quarantine.items() if key == requested or (not requested and (str(shown or '').strip() == key or str(shown or '').strip() in entry['aliases']))]
        if not matches:
            return True

        def inspect():
            for key, entry in matches:
                value = None
                try:
                    compat = self._compat_mod()
                    if self.ACCOUNT.get('verified') and int(self.ACCOUNT.get('hwnd') or 0) == entry['hwnd'] and (compat is not None) and (int(compat.pinned_window() or 0) == entry['hwnd']) and self.wechat_window_alive():
                        value = G.quarantined_input_value(self.gui, entry['hwnd'], entry['aliases'])
                except Exception:
                    pass
                if isinstance(value, str) and (not G.sticker_input_is_blank(value)):
                    entry['draft_observed'] = True
                if G.sticker_input_is_blank(value) and entry['draft_observed']:
                    self.sticker_draft_quarantine.pop(key, None)
                else:
                    return False
            return True
        if gui_locked:
            allowed = inspect()
        else:
            with self.gui_lock:
                allowed = inspect()
        if not allowed:
            G.log_throttled('uncertain-attachment-draft', '发送暂停：上次附件操作可能留有草稿；请手动清空目标输入框后重试。无法读取清空证据时，请手动清空后重启桥接。', ttl=60)
        return allowed

    def sticker_config_now(self):
        if not G.STICKER_TEST_ON:
            return None
        current = G.read_enabled_config(G.CONFIG_PATH)
        if current is None:
            G.STICKER_TEST_ON = False
            return None
        if str((current.get('wechat') or {}).get('account') or '').strip() != G.ACCOUNT_WANTED:
            return None
        return current

    def sticker_gate(self, generation, job_id=''):
        if not generation or self.sticker_config_now() is None:
            return False
        try:
            response = G.LOCAL_HTTP.get(self.sticker_base + '/api/stickers/gate', params={'id': job_id}, headers=self.sticker_headers, timeout=3)
            status = response.json() if response.status_code == 200 else None
            return bool(isinstance(status, dict) and status.get('ok') is True and (status.get('enabled') is True) and (status.get('generation') == generation) and (not job_id or any((isinstance(job, dict) and job.get('id') == job_id and (job.get('status') == 'sending') and (job.get('generation', generation) == generation) for job in status.get('jobs') or []))) and (self.sticker_config_now() is not None))
        except Exception:
            return False

    def sticker_activity_allowed(self, username=''):
        try:
            return not (self.foreground_is_fullscreen() or (username and (username in self.dead_chats or not self.group_is_alive(username))))
        except Exception:
            return False

    def send_sticker(self, path, chat_display_name, chat_username='', generation='', job_id=''):
        """一次性、无导航的图片粘贴；只能向已在前台打开且聚焦的精确会话发送。"""
        if not job_id or not self.sticker_gate(generation, job_id):
            return G.sticker_result('cancelled', 'stickers are disabled or generation expired')
        with self.send_lock, G._SendStateScope(len(str(path or ''))):
            if not self.sticker_gate(generation, job_id):
                return G.sticker_result('cancelled', 'stickers are disabled or generation expired')
            if not self.sticker_quarantine_allows(chat_username, chat_display_name):
                return G.sticker_result('failed', 'an uncertain attachment draft must be cleared manually before further sends')
            if not self.sticker_activity_allowed(chat_username):
                return G.sticker_result('failed', 'activity gate rejected the sticker')
            if not self.account_send_allowed('表情包') or not self.ACCOUNT.get('verified') or (not self.wechat_window_alive()) or (not self.sticker_account_evidence_allowed()):
                return G.sticker_result('failed', 'target account window could not be verified')
            hwnd = int(self.ACCOUNT.get('hwnd') or 0)
            snap = None
            try:
                desktop = G.WindowsDesktop()
                if not desktop.foreground(hwnd):
                    snap = self.snapshot_win_state()
                    if not self.force_foreground(hwnd) or not desktop.foreground(hwnd):
                        try:
                            self.restore_win_state(snap)
                        except Exception:
                            pass
                        snap = None
                        return G.sticker_result('failed', 'could not bring the WeChat window to the foreground')
                    G.log_throttled('sticker-foreground', '表情包：微信不在前台，先切过去（发完会把窗口还原）', ttl=120)
            except Exception:
                try:
                    self.restore_win_state(snap)
                except Exception:
                    pass
                snap = None
                return G.sticker_result('failed', 'foreground safety checks are unavailable')
            try:
                with self.gui_lock:
                    current_gui = self.gui
                    if current_gui is None:
                        return G.sticker_result('failed', 'window driver is not ready')
                    if not self.sticker_gate(generation, job_id):
                        return G.sticker_result('cancelled', 'stickers are disabled or generation expired')
                    try:
                        canonical, aliases = G.resolve_sticker_target(self.db, chat_display_name, chat_username)
                        if not self.sticker_quarantine_allows(canonical, chat_display_name, gui_locked=True):
                            return G.sticker_result('failed', 'an uncertain attachment draft must be cleared manually before further sends')
                        if not self.sticker_activity_allowed(canonical):
                            return G.sticker_result('failed', 'target or activity gate rejected the sticker')
                        if not self.sticker_gate(generation, job_id) or not desktop.foreground(hwnd):
                            return G.sticker_result('cancelled', 'send gates changed before binding')
                        if not current_gui.use_window(hwnd) or int(current_gui.main_hwnd) != hwnd:
                            return G.sticker_result('failed', 'unable to bind the verified account window')
                        uia = getattr(current_gui, '_uia', None)
                        if uia is None:
                            return G.sticker_result('failed', 'UIA target proof is unavailable; no OCR fallback')
                        search_keys = [chat_display_name] + [a for a in aliases if a and a != chat_display_name]
                        try:
                            if not G.sticker_alias_match(uia.current_chat(), aliases):
                                uia.open_chat(search_keys)
                                for _ in range(8):
                                    G.time.sleep(0.25)
                                    if G.sticker_alias_match(uia.current_chat(), aliases):
                                        break
                        except Exception:
                            return G.sticker_result('failed', 'exact target is not open in the pinned window')
                        if not G.sticker_alias_match(uia.current_chat(), aliases):
                            return G.sticker_result('failed', 'exact target is not open in the pinned window')
                        current = self.sticker_config_now()
                        if current is None:
                            return G.sticker_result('cancelled', 'stickers are disabled')
                        directory = (current.get('sticker') or {}).get('dir') or 'data/stickers'
                        directory = directory if G.os.path.isabs(directory) else G.os.path.join(G.ROOT, directory)

                        def pinned_account_valid():
                            try:
                                compat = self._compat_mod()
                                return bool(self.ACCOUNT.get('verified') and int(self.ACCOUNT.get('hwnd') or 0) == hwnd and self.sticker_account_evidence_allowed() and self.wechat_window_alive() and (compat is not None) and (int(compat.pinned_window() or 0) == hwnd))
                            except Exception:
                                return False

                        def transaction_gate():
                            if not self.sticker_gate(generation, job_id):
                                return False
                            latest = self.sticker_config_now()
                            if latest is None:
                                return False
                            latest_dir = (latest.get('sticker') or {}).get('dir') or 'data/stickers'
                            latest_dir = latest_dir if G.os.path.isabs(latest_dir) else G.os.path.join(G.ROOT, latest_dir)
                            wanted_hwnd = int((latest.get('wechat') or {}).get('windowHwnd') or 0)
                            return G.os.path.normcase(G.os.path.abspath(latest_dir)) == G.os.path.normcase(G.os.path.abspath(directory)) and wanted_hwnd in (0, hwnd)
                        G.SEND_STATE['start'] = G.time.time()
                        try:
                            outcome = G.guarded_sticker_send(current_gui, uia, hwnd, aliases, path, directory, self.db, canonical, gate=transaction_gate, account_valid=pinned_account_valid, activity_allowed=lambda: self.sticker_activity_allowed(canonical), desktop=desktop)
                            if not isinstance(outcome, dict) or outcome.get('status') not in {'confirmed', 'unconfirmed', 'failed', 'cancelled'}:
                                raise ValueError('unknown attachment result')
                        except Exception:
                            outcome = G.sticker_result('unconfirmed', 'transport action is uncertain; a draft may remain; do not retry', draft_may_remain=True)
                        if outcome.get('draft_may_remain') or outcome.get('status') == 'unconfirmed':
                            self.sticker_draft_quarantine[canonical] = {'hwnd': hwnd, 'aliases': aliases, 'draft_observed': bool(outcome.get('draft_observed'))}
                        return outcome
                    except Exception:
                        return G.sticker_result('failed', 'sticker safety checks are unavailable')
            finally:
                if snap:
                    try:
                        self.restore_win_state(snap)
                    except Exception:
                        pass

    def claim_and_send_sticker(self, item, expected_chat='', expected_username=''):
        """Atomic claim precedes every send, including normal webhook stickers.

        Never send from an unclaimed payload, never retry a claim or attachment,
        and never interpret a truthy result dictionary as confirmed delivery.
        """
        if not isinstance(item, dict) or not self.sticker_gate(item.get('generation')):
            return G.sticker_result('cancelled', 'stickers are disabled or generation expired')
        job_id = str(item.get('id') or '')
        if not job_id:
            return G.sticker_result('failed', 'sticker job id is missing')
        try:
            response = G.LOCAL_HTTP.post(self.sticker_base + '/api/stickers/claim', json={'id': job_id}, headers=self.sticker_headers, timeout=3)
            claimed = response.json() if response.status_code == 200 else None
            claimed = claimed.get('item') if isinstance(claimed, dict) and claimed.get('ok') is True else None
        except Exception:
            claimed = None
        if not isinstance(claimed, dict):
            return G.sticker_result('failed', 'sticker job was not claimed; nothing was sent')
        if claimed.get('id') != job_id or claimed.get('generation') != item.get('generation') or claimed.get('status') != 'sending' or (expected_chat and (not expected_username) and (claimed.get('chat') != expected_chat)) or (expected_username and claimed.get('chatUsername') != expected_username):
            outcome = G.sticker_result('failed', 'claimed job identity did not match the request')
        else:
            outcome = self.send_sticker(claimed.get('path'), claimed.get('chat') or '', claimed.get('chatUsername') or '', claimed.get('generation'), job_id)
        if self.sticker_gate(item.get('generation')):
            payload = {'id': job_id, 'status': outcome['status'], 'error': outcome['error']}
            for attempt in range(3):
                try:
                    resp = G.LOCAL_HTTP.post(self.sticker_base + '/api/stickers/ack', json=payload, headers=self.sticker_headers, timeout=8)
                    if getattr(resp, 'status_code', 0) in (200, 404, 409):
                        break
                except Exception as exc:
                    if attempt == 2:
                        G.log_throttled('sticker-ack-fail', '表情包结果没能写回服务端（不影响已经发出的消息）：' + repr(exc), ttl=300)
                G.time.sleep(0.4)
            if self.sticker_config_now() is not None:
                G.log('表情包结果：', outcome['status'], outcome['error'])
        return outcome

    def sticker_test_loop(self):
        """常驻但默认休眠：关闭时不访问任何表情包接口、文件或窗口，也不打印日志。"""
        while True:
            try:
                if G.STICKER_TEST_ON and self.sticker_config_now() is not None:
                    response = G.LOCAL_HTTP.get(self.sticker_base + '/api/stickers/pending', headers=self.sticker_headers, timeout=3)
                    body = response.json() if response.status_code == 200 else None
                    items = body.get('items') if isinstance(body, dict) and body.get('ok') is True else []
                    for item in items if isinstance(items, list) else []:
                        if not G.STICKER_TEST_ON or self.sticker_config_now() is None:
                            break
                        self.claim_and_send_sticker(item)
            except Exception:
                pass
            G.time.sleep(5)
