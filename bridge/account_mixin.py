# -*- coding: utf-8 -*-
"""Bridge runtime mixin: AccountMixin."""
import engine as G


class AccountMixin:

    def _open_db_with_timeout(self, timeout=90):
        box = {}

        def _work():
            try:
                box['db'] = self.WeChatDB(db_dir=self.db_dir, account=self.acct or None) if self.db_dir else self.WeChatDB(account=self.acct or None)
            except BaseException as exc:
                box['err'] = exc
        th = G.threading.Thread(target=_work, name='open-db', daemon=True)
        th.start()
        th.join(timeout)
        if th.is_alive():
            box['timeout'] = True
        return box

    def _heal_accounts_cache(self):
        try:
            path = G.os.path.join(G.ROOT, 'data', 'accounts.json')
            stale = True
            if G.os.path.exists(path):
                try:
                    with open(path, 'r', encoding='utf-8') as f:
                        old = G.json.load(f)
                    stale = not (str(old.get('dbDir') or '').strip() and old.get('accounts'))
                except Exception:
                    stale = True
            if stale:
                G.write_accounts_cache(self.db.db_dir or self.db_dir, self.db.account, self._self_nick)
        except Exception as e:
            G.log('账号缓存检查失败（不影响收发）：', repr(e))

    def display_name(self, username):
        if username in self.name_cache:
            return self.name_cache[username]
        name = ''
        ok = False
        try:
            if username.endswith('@chatroom'):
                name = self.db.group_id_to_name(username) or ''
                if not name:
                    s = self.sessions.get(username) or {}
                    name = s.get('last_sender') or ''
            else:
                name = self.db.get_nickname(username) or ''
            ok = True
        except Exception:
            name = ''
        name = name or username
        if ok and name != username:
            self.name_cache[username] = name
        return name

    def aliases_for(self, username, shown=''):
        """会话列表里那一行可能叫什么（微信里没命名的群，显示的是成员名）。

        实测：群 00000000000@chatroom 在数据库里 nick_name 是空的，会话列表里显示
        「成员甲、成员乙『示例群』」—— 按群名/open_chat 都匹配不上，所以这里把
        「成员名用、连起来」也当候选名。
        """
        key = (username or '', shown or '')
        if key in self.alias_cache:
            return self.alias_cache[key]
        out = []
        partial = False
        if shown and shown != username and (not str(shown).endswith('@chatroom')):
            out.append(shown)
        if username and str(username).endswith('@chatroom'):
            try:
                nm = self.db.group_id_to_name(username) or ''
            except Exception:
                nm = ''
                partial = True
            if nm and nm != username:
                out.append(nm)
            try:
                nicks = []
                for m in self.db.get_group_members(username) or []:
                    if m.get('username') == self.me:
                        continue
                    n = (m.get('remark') or '').strip() or (m.get('nick_name') or '').strip()
                    if n:
                        nicks.append(n)
                if nicks:
                    out.append('、'.join(nicks))
            except Exception:
                partial = True
        if not out:
            out.append(shown or username)
        out = [x for x in dict.fromkeys(out) if x]
        if not partial:
            self.alias_cache[key] = out
        return out

    def _account_locked(self, fn):
        """把账号窗口绑定函数整体罩进 account_lock（见上面注释）。"""

        def _wrap(*args, **kwargs):
            with self.account_lock:
                return fn(*args, **kwargs)
        _wrap.__name__ = fn.__name__
        return _wrap

    def _compat_mod(self):
        return G.sys.modules.get('uia_compat')

    def _account_recent_names(self, limit=12):
        """这个账号最近的会话名（用来和窗口里看得见的会话行做比对）。"""
        want = []
        try:
            rows = self.db.get_sessions(limit=limit) or []
        except Exception as e:
            G.log('账号窗口：读会话列表失败：', repr(e))
            return want
        for s in rows:
            u = s.get('username') or ''
            try:
                nm = self.display_name(u)
            except Exception:
                nm = ''
            if nm and nm != u:
                want.append(nm)
        return want

    def _probe_wechat_windows(self):
        """[(hwnd, 控件, 可见会话行名...)]：纯只读，不点任何东西。

        先对每个主窗热激活 mmui 树（只写 accessibility gate 字节，不置前、不点击），
        否则刚启动时子控件还是空的，读不到会话行。
        """
        import win32gui
        import win32process
        from wechatauto.uia_driver import WeChatUIA
        self.ensure_uia_ready()
        probe = WeChatUIA()
        out = []
        try:
            hwnds = list(probe._wechat_hwnds() or ())
        except Exception:
            hwnds = []
        pinned = int(self.ACCOUNT.get('hwnd') or 0) if self.ACCOUNT.get('verified') else 0
        if pinned:
            try:
                _ppid = int(win32process.GetWindowThreadProcessId(pinned)[1] or 0)
                if not (win32gui.IsWindow(pinned) and _ppid and probe._weixin_dll_module(_ppid)):
                    G.log('账号窗口：锁定的 hwnd=%s 已失效，重新认窗口' % pinned)
                    self.ACCOUNT.update(hwnd=0, verified=False)
                    pinned = 0
            except Exception:
                self.ACCOUNT.update(hwnd=0, verified=False)
                pinned = 0
        for h in hwnds:
            h = int(h)
            try:
                cls = win32gui.GetClassName(h) or ''
                title = (win32gui.GetWindowText(h) or '').strip()
                if pinned and h != pinned:
                    continue
            except Exception:
                cls, title = ('', '')
            if not ('QWindowIcon' in cls or 'mmui::' in cls):
                continue
            if title != '微信':
                continue
            try:
                _cpid = int(win32process.GetWindowThreadProcessId(h)[1] or 0)
                if _cpid and (not probe._weixin_dll_module(_cpid)):
                    continue
            except Exception:
                pass
            try:
                probe._hot_activate_accessibility(h)
            except Exception:
                pass
            c = None
            rows = []
            for _try in range(2):
                try:
                    c = probe._anchor(h)
                except Exception:
                    c = None
                rows = []
                if c is not None and hasattr(probe, '_session_rows_of'):
                    try:
                        rows = [nm for nm, _ctl in probe._session_rows_of(c)]
                    except Exception:
                        rows = []
                if rows:
                    break
                G.time.sleep(0.4)
            out.append((h, c, rows))
        return (probe, out)

    def bind_gui_window(self, g):
        """把 WeChatGUI 的坐标/OCR 目标也对齐到锁定的账号窗口。"""
        if g is None:
            return g
        if self.ACCOUNT.get('hwnd'):
            try:
                g.use_window(self.ACCOUNT['hwnd'])
            except Exception:
                pass
        return g

    def rebind_uia(self, hwnd, engine=None):
        """把 UIA 引擎 + uia_compat 的钉窗 + GUI 目标全部对齐到 hwnd。"""
        hwnd = int(hwnd or 0)
        if not hwnd:
            return False
        m = self._compat_mod()
        if m is not None:
            try:
                m.pin_window(hwnd)
            except Exception:
                pass
        targets = []
        if engine is not None:
            targets.append(engine)
        try:
            if self.UIA_CACHE.get('u') is not None:
                targets.append(self.UIA_CACHE['u'])
        except Exception:
            pass
        for u in targets:
            try:
                u._pinned_hwnd = hwnd
                u._win = u._anchor(hwnd) or u._win
            except Exception:
                pass
        try:
            if self.gui is not None:
                self.gui.use_window(hwnd)
        except Exception:
            pass
        return True

    def pick_account_window(self, force=False, quiet=False):
        """确认哪个微信窗口是 config/网页指定的账号，并钉死它。"""
        if self.ACCOUNT['verified'] and (not force):
            return True
        if G.WINDOW_HWND:
            try:
                import win32gui
                if win32gui.IsWindow(G.WINDOW_HWND):
                    self.ACCOUNT.update(hwnd=G.WINDOW_HWND, verified=True, label='hwnd=%s（配置）' % G.WINDOW_HWND, why='config.wechat.windowHwnd')
                    m = self._compat_mod()
                    if m is not None:
                        try:
                            m.pin_window(G.WINDOW_HWND)
                        except Exception:
                            pass
                    if not quiet:
                        G.log('账号窗口：按 config 的 wechat.windowHwnd=%s 直接锁定' % G.WINDOW_HWND)
                    return True
            except Exception:
                pass
        probe, cands = self._probe_wechat_windows()
        if not cands:
            self.ACCOUNT.update(verified=False, hwnd=0, why='没扫到微信主窗')
            return False
        if len(cands) == 1:
            h, _c, _rows = cands[0]
            why = '已锁定窗口' if int(self.ACCOUNT.get('hwnd') or 0) == h else '本机只登了一个号'
            self.ACCOUNT.update(hwnd=h, verified=True, label='hwnd=%s' % h, why=why)
            m = self._compat_mod()
            if m is not None:
                try:
                    m.pin_window(h)
                except Exception:
                    pass
            if not quiet:
                G.log('账号窗口：只有一个微信主窗（hwnd=%s），直接用它' % h)
            return True
        want = self._account_recent_names()
        G.log('账号窗口：本机有 %d 个微信主窗，按账号 %s 的最近会话认窗口：%s' % (len(cands), self.db.account, ' / '.join(want[:6]) or '（空）'))
        for h, _c, rows in cands:
            G.log('   hwnd=%s 可见 %d 行：%s' % (h, len(rows), ' | '.join(rows[:6]) or '（读不到会话列表）'))
        score_fn = getattr(probe, '_row_score', None)
        scored = []
        for h, c, rows in cands:
            if not rows:
                continue
            hits = []
            for i, nm in enumerate(want):
                for r in rows:
                    if score_fn is not None:
                        try:
                            if score_fn(r, [nm]) == 0:
                                hits.append(i)
                                break
                        except Exception:
                            continue
                    elif r.strip() == str(nm).strip():
                        hits.append(i)
                        break
            scored.append((bool(hits and hits[0] == 0), len(hits), h, c, rows))
        if not scored:
            self.ACCOUNT.update(verified=False, hwnd=0, why='每个微信窗口都读不到会话列表')
            return False
        scored.sort(key=lambda x: (x[0], x[1]), reverse=True)
        newest_ok, nhit, h, _c, rows = scored[0]
        if sum((1 for candidate in scored if candidate[:2] == scored[0][:2])) != 1:
            self.ACCOUNT.update(verified=False, hwnd=0, why='多个微信窗口的账号证据相同，不能唯一确认')
            return False
        if not newest_ok:
            best_hits = scored[0][1]
            tied = [x for x in scored if x[1] == best_hits]
            if best_hits < 2 or len(tied) > 1:
                self.ACCOUNT.update(verified=False, hwnd=0, why='没有一个窗口对得上账号 %s 的最近会话' % self.db.account)
                return False
        self.ACCOUNT.update(hwnd=h, verified=True, label='hwnd=%s' % h, why='命中最近会话 %d 条' % nhit)
        m = self._compat_mod()
        if m is not None:
            try:
                m.pin_window(h)
            except Exception as e:
                G.log('账号窗口：pin_window 失败：', repr(e))
        G.log('账号窗口：锁定 hwnd=%s（%d 个窗口里对上 %d 条最近会话%s）' % (h, len(scored), nhit, '，最新一条也在' if newest_ok else ''))
        return True

    def ensure_account_window(self, engine=None):
        """发送前确认「锁定的微信窗口」还活着；微信重启/换号后自动重认。

        不这么做的话：微信重开一次，hwnd 变了，而 ACCOUNT["verified"] 还是 True，
        于是每次发送都被「引擎窗口和锁定窗口不一致」拦下、连失败两次后会话被标死。
        """
        hw = int(self.ACCOUNT.get('hwnd') or 0)
        alive = False
        if hw:
            try:
                import win32gui
                alive = bool(win32gui.IsWindow(hw))
            except Exception:
                alive = False
        if self.ACCOUNT.get('verified') and alive:
            m = self._compat_mod()
            if m is not None:
                try:
                    if int(m.pinned_window() or 0) != hw:
                        self.rebind_uia(hw, engine)
                        G.log('账号窗口：UIA 钉窗和锁定窗口不一致，已钉回 hwnd=%s' % hw)
                except Exception:
                    pass
            return True
        if hw and (not alive):
            G.log('⚠️ 锁定的微信窗口 hwnd=%s 已经不在了（微信重启/换号），重新认账号…' % hw)
            self.ACCOUNT.update(verified=False, why='锁定窗口已失效')
        try:
            ok = self.pick_account_window(force=True, quiet=True)
        except Exception as e:
            G.log('重新认账号失败：', repr(e))
            return False
        if not ok:
            return False
        self.rebind_uia(self.ACCOUNT.get('hwnd'), engine)
        G.log('账号窗口已重新锁定 hwnd=%s（%s）' % (self.ACCOUNT.get('hwnd'), self.ACCOUNT.get('why') or ''))
        return True

    def configured_account_dir(self):
        """config.json 里现在钉的是哪个账号 → 真实账号目录（没钉返回空串）。"""
        try:
            mt = G.os.path.getmtime(G.CONFIG_PATH)
        except OSError:
            return ''
        c = self._pin_cache
        if mt != c['mtime']:
            c['mtime'] = mt
            c['wanted'] = str((G.read_config().get('wechat') or {}).get('account') or '').strip()
            c['dir'] = ''
        wanted = c['wanted']
        if not wanted:
            return ''
        current = str(getattr(self.db, 'account', '') or '')
        if wanted == current or G.account_wxid(wanted) == G.account_wxid(current) or (current and current.lower().startswith(wanted.lower())):
            return current
        if not c['dir']:
            try:
                c['dir'] = G.resolve_account_dir(self.db.db_dir or self.db_dir, wanted) or ''
            except Exception:
                c['dir'] = ''
        return c['dir']

    def account_send_allowed(self, where, engine=None):
        """统一的发送闸：认不出目标账号窗口、或窗口里的号不是配置指定的号，就不发。"""
        pinned = self.configured_account_dir()
        current = str(getattr(self.db, 'account', '') or '')
        if pinned and pinned != current:
            self.ACCOUNT['blockedAt'] = G.time.time()
            G.log_throttled('account-pin-mismatch', '⚠️ 不发送（%s）：config 里选的账号是 %s，但桥接现在连的是 %s。切号后桥接没重启成功，先从别的号发就露馅了 —— 重启桥接后再发。' % (where, pinned, current), ttl=60)
            return False
        if self.ensure_account_window(engine):
            return True
        if G.ACCOUNT_GUARD:
            self.ACCOUNT['blockedAt'] = G.time.time()
            G.log('⚠️ 不发送（%s）：没能确认哪个微信窗口是账号 %s（%s）；现在可能同时登着别的号，乱发会从别人的号发出去。' % (where, self.db.account, self.ACCOUNT['why'] or '未知'))
            return False
        return True

    def group_is_alive(self, chat_username):
        """被踢出群后，群会话还在，但发不出去；先查成员列表。"""
        if not str(chat_username).endswith('@chatroom'):
            return True
        try:
            members = self.db.get_group_members(chat_username) or []
            ids = {str(m.get('wxid') or m.get('username')) for m in members}
            return self.self_wxid in ids
        except Exception:
            return True

    def wechat_main_window_count(self):
        """当前登着几个微信账号 = 标题为「微信」的主窗数量。

        现场问题：设置窗、独立聊天窗、群公告弹窗也都是 QWindowIcon，但标题
        分别是「设置」/ 联系人名 / 群公告。以前只按类名计数，把「设置」当成
        第二个账号，于是「本机只登了一个号」的机器被误判成多开，私聊表情包
        全被账号闸拒绝（日志：表情包跳过 / 账号信息不一致）。
        """
        try:
            import win32gui
            from wechatauto.uia_driver import WeChatUIA
            probe = WeChatUIA()
            hwnds = list(probe._wechat_hwnds() or ())
        except Exception:
            return None
        count = 0
        for h in hwnds:
            try:
                cls = win32gui.GetClassName(int(h)) or ''
                title = (win32gui.GetWindowText(int(h)) or '').strip()
            except Exception:
                continue
            if ('QWindowIcon' in cls or 'mmui::' in cls) and title == '微信':
                count += 1
        return count

    def sticker_account_evidence_allowed(self):
        explicit_pin = bool(G.WINDOW_HWND and int(G.WINDOW_HWND) == int(self.ACCOUNT.get('hwnd') or 0))
        allowed = G.sticker_account_evidence_ok(configured_account=G.ACCOUNT_WANTED, db_account=getattr(self.db, 'account', ''), reason=self.ACCOUNT.get('why'), explicit_pin=explicit_pin, account_dirs=self.acct_dirs, visible_windows=self.wechat_main_window_count())
        if not allowed:
            G.log_throttled('sticker-account-ambiguous', '表情包跳过：当前微信窗口和账号信息不一致，或多个窗口无法区分。只登录一个号且数据库匹配时无需手选；多开时请在设置中选账号。', ttl=300)
        return allowed
