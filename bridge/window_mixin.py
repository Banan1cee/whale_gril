# -*- coding: utf-8 -*-
"""Bridge runtime mixin: WindowMixin."""
import engine as G


class WindowMixin:

    def foreground_is_fullscreen(self):
        """前台是不是「真全屏」程序（全屏游戏、全屏视频）。

        3.9 起「打游戏就休息/排队」的行为已经删掉，这个检测只剩一个用途：
        主动发起的消息（主动搭话、提醒、表情包）在全屏时先跳过，
        免得抢焦点；被动回复不再看它。

        不能拿屏幕尺寸判断：Windows 上最大化窗口的 GetWindowRect 带 DWM 隐形边框，
        实测 2560x1440 的屏幕，最大化浏览器返回 rect=(-8,-8,2568,1448)，
        旧的 `r[2] >= sw-2 and r[3] >= sh-2` 会把它当全屏 ——
        表现就是「用户把窗口一最大化，她就不理人了」（3.3.1 实测复现）。

        改成两条一起判：
          ① 盖住整个显示器（MonitorFromWindow 取 rcMonitor，不是屏幕尺寸）；
          ② 没有标题栏和边框（真全屏游戏/无边框视频都是 WS_POPUP）。
        最大化窗口带 WS_CAPTION|WS_THICKFRAME，因此被正确排除。
        """
        try:
            import ctypes
            import ctypes.wintypes as wt
            import psutil
            import win32con
            import win32gui
            import win32process
            h = win32gui.GetForegroundWindow()
            if not h:
                return False
            _, pid = win32process.GetWindowThreadProcessId(h)
            name = psutil.Process(pid).name().lower()
            if name.startswith('weixin'):
                return False
            style = win32gui.GetWindowLong(h, win32con.GWL_STYLE)
            if style & win32con.WS_CAPTION and style & win32con.WS_THICKFRAME:
                return False

            class _MONITORINFO(ctypes.Structure):
                _fields_ = [('cbSize', wt.DWORD), ('rcMonitor', wt.RECT), ('rcWork', wt.RECT), ('dwFlags', wt.DWORD)]
            user32 = ctypes.windll.user32
            mi = _MONITORINFO()
            mi.cbSize = ctypes.sizeof(_MONITORINFO)
            hmon = user32.MonitorFromWindow(h, 2)
            if not user32.GetMonitorInfoW(hmon, ctypes.byref(mi)):
                return False
            mon = mi.rcMonitor
            r = win32gui.GetWindowRect(h)
            return r[0] <= mon.left + 1 and r[1] <= mon.top + 1 and (r[2] >= mon.right - 1) and (r[3] >= mon.bottom - 1)
        except Exception:
            return False

    def find_weixin_hwnd(self):
        try:
            import win32gui
            import win32con
            import win32process
            import psutil
        except Exception:
            return 0
        found = []
        BAD_CLASS = ('trayicon', 'messagewindow', 'msctf', 'sopy', 'sogou', 'hintwnd', 'default ime', 'notifyicon')

        def cb(h, _):
            try:
                title = win32gui.GetWindowText(h) or ''
                _, pid = win32process.GetWindowThreadProcessId(h)
                if pid <= 0:
                    return
                cls = win32gui.GetClassName(h) or ''
                low = cls.lower()
                if any((bad in low for bad in BAD_CLASS)):
                    return
                rect = win32gui.GetWindowRect(h)
                area = max(0, rect[2] - rect[0]) * max(0, rect[3] - rect[1])
                if win32gui.IsIconic(h):
                    try:
                        rc = win32gui.GetWindowPlacement(h)[4]
                        area = max(0, rc[2] - rc[0]) * max(0, rc[3] - rc[1]) or area
                    except Exception:
                        pass
                if area < 300 * 250 and title.strip() != '微信':
                    return
                try:
                    name = psutil.Process(pid).name().lower()
                except Exception:
                    return
                if not name.startswith('weixin'):
                    return
                if '发送' in title or '助手' in title:
                    return
                try:
                    style = win32gui.GetWindowLong(h, win32con.GWL_STYLE)
                    has_min_box = bool(style & win32con.WS_MINIMIZEBOX)
                except Exception:
                    has_min_box = False
                is_main_title = title.strip() == '微信'
                looks_main_class = 'qwindowicon' in low or 'mmui::mainwindow' in low
                score = area
                if is_main_title:
                    score += 10 ** 9
                if looks_main_class:
                    score += 10 ** 8
                if has_min_box:
                    score += 10 ** 7
                found.append((score, 1 if is_main_title else 0, h))
            except Exception:
                pass
        try:
            win32gui.EnumWindows(cb, None)
        except Exception:
            return 0
        if not found:
            return 0
        found.sort(reverse=True)
        return found[0][2]

    def wechat_window_alive(self):
        """微信主窗现在是否还存在（每次现找，不缓存 —— 微信窗口回收/更新后，缓存句柄会失效）。

        长时间挂着不管时，微信可能半夜自更新、或把窗口拆了重开，此时 uiautomation
        手里还攥着旧窗口的 COM 指针 / 句柄，再碰一次就直接 0xC0000005（访问违规），
        Python 的 try/except 拦不住，进程当场死掉 —— 也就是「Bridge exited with code
        -1073741819」。这些 UIA 调用前先问一句窗口还在不在，就能把这种崩溃挡在外面。
        """
        try:
            import win32gui
            h = int(self.ACCOUNT.get('hwnd') or 0) or self.find_weixin_hwnd()
            return bool(h and win32gui.IsWindow(h))
        except Exception:
            return False

    def wechat_window_state(self):
        """心跳上报的窗口现场：主窗在不在、可见/最小化/托盘。纯只读，不动窗口。

        排查「她不回消息」时第一个要看的就是这个：窗口缩进托盘、被自更新回收、
        或者双开时钉错了号，日志里一眼能看出来。
        """
        try:
            import win32gui
            w = self.find_weixin_hwnd()
            if not w:
                return '没有微信主窗（未登录或已退出）'
            h = int(self.ACCOUNT.get('hwnd') or 0) or int(w)
            if not win32gui.IsWindow(h):
                return '主窗句柄失效（微信可能自更新/重启过）'
            if win32gui.IsIconic(h):
                return '已最小化'
            if not win32gui.IsWindowVisible(h):
                return '在托盘（窗口隐藏）'
            return '可见'
        except Exception as e:
            return '读不到窗口状态（%s）' % type(e).__name__

    def normalize_window(self, hwnd):
        """微信窗口太小 / 超出屏幕 / 被挪走都会让 UI 自动化点空，统一调成稳定尺寸。"""
        try:
            import win32gui
            import win32con
            import win32api
            sw, sh = (win32api.GetSystemMetrics(0), win32api.GetSystemMetrics(1))
            rect = win32gui.GetWindowRect(hwnd)
            x, y, w, h = (rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1])
            tw, th = (min(1320, sw - 160), min(900, sh - 160))
            need = w < 1080 or h < 760 or w > sw - 80 or (h > sh - 80) or (x < -20) or (y < -20) or (x + w > sw + 20) or (y + h > sh + 20)
            if need:
                win32gui.SetWindowPos(hwnd, win32con.HWND_TOP, 40, 20, tw, th, win32con.SWP_SHOWWINDOW)
                G.log('微信窗口调整：%dx%d @(%d,%d) → %dx%d（保证自动发送稳定）' % (w, h, x, y, tw, th))
                G.time.sleep(0.8)
        except Exception as e:
            G.log_window_problem('调整微信窗口失败（继续发送）', e)

    def force_send_foreground(self, fn, *, require_foreground=False):
        """把微信拉到前台再发送（真正的兜底路径）。

        注意：实测下来大多数时候**不需要**这条路 —— 微信最小化、被别的窗口挡住、
        甚至前台是全屏程序时，UIA 都能正常发送（见 docs/接入微信.md 的实测数据）。
        所以它只作为「后台发送失败后」的第二次尝试。
        """
        hwnd = int(self.ACCOUNT.get('hwnd') or 0)
        if not hwnd:
            if require_foreground:
                G.log('表情包前台模式：找不到已选微信窗口，本次未发送')
                return False
            hwnd = self.find_weixin_hwnd()
        was_topmost = False
        touched = False
        try:
            import win32gui
            import win32con
            if hwnd:
                try:
                    if not win32gui.IsWindowVisible(hwnd):
                        win32gui.ShowWindow(hwnd, win32con.SW_SHOW)
                        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
                        G.log('微信在托盘里，已把主窗口拉出来再发送')
                        G.time.sleep(0.4)
                except Exception as e:
                    G.log('拉出微信窗口失败：', repr(e))
                self.normalize_window(hwnd)
                try:
                    fg = win32gui.GetForegroundWindow()
                except Exception:
                    fg = 0
                if fg != hwnd:
                    touched = True
                    self.force_foreground(hwnd)
                    ex = win32gui.GetWindowLong(hwnd, win32con.GWL_EXSTYLE)
                    was_topmost = bool(ex & win32con.WS_EX_TOPMOST)
                    try:
                        win32gui.SetWindowPos(hwnd, win32con.HWND_TOPMOST, 0, 0, 0, 0, win32con.SWP_NOMOVE | win32con.SWP_NOSIZE)
                    except Exception as e:
                        G.log_window_problem('窗口置顶失败（继续发送）', e)
                    win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
                    G.time.sleep(0.2)
            if require_foreground and win32gui.GetForegroundWindow() != hwnd:
                G.log('表情包前台模式：微信未进入前台，本次未发送')
                return False
            return fn()
        finally:
            try:
                if touched and hwnd and (not was_topmost):
                    import win32gui
                    import win32con
                    win32gui.SetWindowPos(hwnd, win32con.HWND_NOTOPMOST, 0, 0, 0, 0, win32con.SWP_NOMOVE | win32con.SWP_NOSIZE)
            except Exception:
                pass

    def with_window_on_top(self, fn):
        """发送前确保能发出去。

        默认**不长期占用前台**（backgroundSend=true）：
          1. 先直接让 UIA 在后台发（微信最小化/被遮挡也能发，实测 18/18）；
          2. 万一失败，才把微信拉到前台重试一次；
          3. 不管成功失败，**发完都把窗口状态还原**（该最小化的重新最小化、前台还给原来的窗口），
             这样你在用电脑时最多看到它闪一下。
        把 wechat.backgroundSend 设成 false 就退回以前的「每次先抢前台、发完不管」。
        """
        force_front = G.STICKER_TEST_ON
        restore_after = G.BACKGROUND_SEND
        snap = self.snapshot_win_state() if restore_after else None
        try:
            if force_front:
                return self.force_send_foreground(fn, require_foreground=True)
            if restore_after:
                try:
                    if fn():
                        return True
                except G.ChatIdentityError:
                    raise
                except Exception as e:
                    G.log('后台发送异常，改走前台重试：', repr(e))
                G.log('后台发送没成功，把微信拉到前台再试一次')
                return self.force_send_foreground(fn)
            return self.force_send_foreground(fn)
        finally:
            if restore_after:
                self.restore_win_state(snap)

    def force_foreground(self, hwnd):
        """把微信强制拉到前台，并且**确认真的到位**。

        原来的实现「调用完就 return True」，但 SetForegroundWindow 会被 Windows
        的前台锁拒绝（你正在浏览器里打字时尤其明显），于是表情包发送时判断
        「微信不在前台」→ 直接失败。现在每轮都读一次 GetForegroundWindow 复核，
        并补上两种业界常用的解锁手段：
          ① 轻点一下 ALT 解除前台锁，再 SwitchToThisWindow；
          ② AttachThreadInput + BringWindowToTop + SetForegroundWindow。
        连续几轮都不成功才返回 False，交给调用方明确报错。
        """
        try:
            import ctypes
            import win32api
            import win32con
            import win32gui
        except Exception:
            return False
        hwnd = int(hwnd or 0)
        if not hwnd:
            return False
        user32 = ctypes.windll.user32
        try:
            if win32gui.GetForegroundWindow() == hwnd:
                return True
        except Exception:
            return False
        for _attempt in range(4):
            try:
                fg = win32gui.GetForegroundWindow()
                tid_fg = user32.GetWindowThreadProcessId(fg, None)
                tid = user32.GetWindowThreadProcessId(hwnd, None)
                try:
                    user32.AttachThreadInput(tid_fg, tid, True)
                    win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
                    user32.BringWindowToTop(hwnd)
                    win32gui.SetForegroundWindow(hwnd)
                finally:
                    try:
                        user32.AttachThreadInput(tid_fg, tid, False)
                    except Exception:
                        pass
                if win32gui.GetForegroundWindow() == hwnd:
                    return True
                win32api.keybd_event(win32con.VK_MENU, 0, 0, 0)
                win32api.keybd_event(win32con.VK_MENU, 0, win32con.KEYEVENTF_KEYUP, 0)
                G.time.sleep(0.05)
                try:
                    user32.SwitchToThisWindow(hwnd, True)
                except Exception:
                    pass
                G.time.sleep(0.15)
                if win32gui.GetForegroundWindow() == hwnd:
                    return True
            except Exception:
                pass
            G.time.sleep(0.15)
        try:
            return win32gui.GetForegroundWindow() == hwnd
        except Exception:
            return False

    def _input_value(self, u):
        """尽量读出输入框当前文字；读不到返回空串。"""
        try:
            e = u._chat_input()
            if e is None:
                return ''
            for name in ('get_value', 'value'):
                try:
                    v = getattr(e, name)
                    v = v() if callable(v) else v
                    if v is not None:
                        return str(v)
                except Exception:
                    pass
            try:
                return str(e.iface_value.Value)
            except Exception:
                pass
        except Exception:
            pass
        return ''

    def press_enter(self, with_ctrl=False):
        """用底层按键补发 Enter（UIA 的 SendKeys 有时不触发发送）。"""
        try:
            import win32api
            import win32con
            hwnd = int(self.ACCOUNT.get('hwnd') or 0) or self.find_weixin_hwnd()
            if hwnd:
                self.force_foreground(hwnd)
            G.time.sleep(0.1)
            if with_ctrl:
                win32api.keybd_event(17, 0, 0, 0)
            win32api.keybd_event(13, 0, 0, 0)
            win32api.keybd_event(13, 0, win32con.KEYEVENTF_KEYUP, 0)
            if with_ctrl:
                win32api.keybd_event(17, 0, win32con.KEYEVENTF_KEYUP, 0)
            G.time.sleep(0.25)
            return True
        except Exception as e:
            G.log('手动回车失败：', repr(e))
            return False

    def snapshot_win_state(self):
        """记下发送前的「窗口长什么样」，发完要还原。

        要还原的东西：微信是不是最小化、原来哪个窗口在前台。
        """
        snap = {'hwnd': 0, 'iconic': False, 'fg': 0}
        try:
            import win32gui
            snap['hwnd'] = int(self.ACCOUNT.get('hwnd') or 0) or self.find_weixin_hwnd() or 0
            if snap['hwnd']:
                snap['iconic'] = bool(win32gui.IsIconic(snap['hwnd']))
            snap['fg'] = win32gui.GetForegroundWindow() or 0
        except Exception:
            pass
        return snap

    def restore_win_state(self, snap):
        """把窗口状态还原：微信重新最小化，前台还给刚才那个窗口。

        实测（2026-10-25 02:5x）：微信最小化 + 前台是浏览器时发一条，窗口会被抬起约 5 秒；
        发完立刻最小化并把前台还回去，用户几乎无感。
        SetForegroundWindow 会被前台锁拒绝，所以带 ALT 解锁 + 重试 + SwitchToThisWindow 兜底。
        """
        if not snap:
            return
        try:
            import ctypes
            import win32gui
            import win32con
            import win32api
            wx = snap.get('hwnd')
            if wx and snap.get('iconic'):
                try:
                    win32gui.ShowWindow(wx, win32con.SW_MINIMIZE)
                except Exception:
                    pass
                G.time.sleep(0.12)
            fg = snap.get('fg')
            if not fg or fg == wx or (not win32gui.IsWindow(fg)):
                return
            for attempt in range(3):
                try:
                    win32api.keybd_event(win32con.VK_MENU, 0, 0, 0)
                    win32api.keybd_event(win32con.VK_MENU, 0, win32con.KEYEVENTF_KEYUP, 0)
                    G.time.sleep(0.04)
                    ctypes.windll.user32.SetForegroundWindow(fg)
                except Exception as _e:
                    G.log('还原前台重试 %d/3：%r' % (attempt + 1, _e))
                G.time.sleep(0.12)
                if ctypes.windll.user32.GetForegroundWindow() == fg:
                    return
                try:
                    ctypes.windll.user32.SwitchToThisWindow(fg, True)
                except Exception:
                    pass
                G.time.sleep(0.12)
                if ctypes.windll.user32.GetForegroundWindow() == fg:
                    return
            G.log_window_problem('还原前台失败（窗口已最小化，不影响使用）', None)
        except Exception as e:
            G.log_window_problem('还原窗口状态失败', e)

    def install_quiet_uia(self, u):
        """让 UIA 引擎「别抢前台」。

        wechatauto 的 WeChatUIA.ensure_window() 每次都会调 _activate() →
        _force_foreground()/ShowWindow(9)，也就是把微信窗口恢复并抢到最前面。
        实测 18/18：微信最小化、被遮挡、前台全屏时其实都能发，所以这步纯属多余，
        代价是你正在用的电脑被反复打断。

        这里给引擎实例打个补丁：quiet_mode 打开时 _activate 直接返回。
        不改第三方库文件，随桥接一起走；万一后台发不出去，force_send_foreground()
        会显式把窗口拉出来，不依赖这个补丁。
        """
        try:
            import types
            if getattr(u, '_whale_quiet_patch', False):
                u.quiet_mode = True
                return
            orig = u._activate

            def patched(self, win, _orig=orig):
                if getattr(self, 'quiet_mode', False):
                    return
                return _orig(win)
            u._activate = types.MethodType(patched, u)
            u._whale_quiet_patch = True
            u.quiet_mode = True
        except Exception as e:
            G.log('后台模式补丁没打上（不影响发送）：', repr(e))

    def _bg_hwnd(self):
        try:
            return int(self.ACCOUNT.get('hwnd') or 0) or self.find_weixin_hwnd()
        except Exception:
            return 0

    def _require_chat_identity(self, u, who, keys, where):
        """发送前硬闸：当前开着的会话必须真是目标会话，对不上就整条不发。

        日志里永远打一行「目标 / 当前 / 结论」：串会话时能一眼看出是谁发到了谁家。
        抛 ChatIdentityError 让 send_text 直接放弃 —— 换通道救不了，因为换哪条
        通道都是往「当前那个会话」的输入框里打字。

        刚点完会话行时标题可能还没刷新，所以读不到/对不上都先重试 3 次（每次 0.3 秒），
        仍然对不上才拒绝 —— 别把「还没刷出来」误判成「发错人」把正常发送全堵死。
        """
        cur = ''
        lvl = None
        for attempt in range(3):
            try:
                cur = u.current_chat()
            except Exception as e:
                cur = ''
                if attempt == 2:
                    G.log_error('%s 会话核对：读不到当前会话名（%r），这条不发' % (where, e))
            lvl = G._chat_identity_level(cur, keys)
            if lvl is not None:
                break
            G.time.sleep(0.3)
        G.log('[核对] %s 目标=%s 当前=%r → %s' % (where, who, cur, '通过' if lvl is not None else '不是目标，拒绝发送'))
        if lvl is None:
            raise G.ChatIdentityError('当前会话 %r 不是目标 %r' % (cur, who))
        return cur
