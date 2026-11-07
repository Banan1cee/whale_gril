# -*- coding: utf-8 -*-
"""Bridge runtime mixin: LoopMixin."""
import engine as G


class LoopMixin:

    def care_watch(self):
        """主动搭话：没事的时候她自己来问一句「在干啥 / 累不累」。

        3.9 起**判定只在服务端做一次**（时间窗 / 频率 / 每日上限 / 白名单 / 三个开关），
        这里只负责：到点问一次 → 按服务端给的目标发 → 记账。
        以前桥接自己维护一套 onlyMaster/allowGroups/allowOthers，和服务端那套不一致，
        而且 master.wxids 为空时会把所有会话都筛掉 —— 表现就是「改了开关没反应」。
        """
        state_file = G.os.path.join(G.ROOT, 'data', 'care-state.json')

        def load_state():
            try:
                with open(state_file, 'r', encoding='utf-8') as f:
                    return G.json.load(f) or {}
            except Exception:
                return {}

        def save_state(st):
            try:
                G.os.makedirs(G.os.path.dirname(state_file), exist_ok=True)
                with open(state_file, 'w', encoding='utf-8') as f:
                    G.json.dump(st, f, ensure_ascii=False)
            except Exception:
                pass
        while True:
            G.time.sleep(60)
            if not G.CARE_ENABLED:
                continue
            if self.foreground_is_fullscreen():
                continue
            st = load_state()
            last_ts = float(st.get('lastTs') or 0)
            today = G.time.strftime('%Y-%m-%d')
            sent = int(st.get('count') or 0) if st.get('day') == today else 0
            base = self.bot_url.rsplit('/webhook', 1)[0]
            active = []
            if G.CARE_QUIET_MIN > 0:
                try:
                    active = [u for u, _n in self.recent_chats(limit=50, within=int(G.CARE_QUIET_MIN * 60))]
                except Exception:
                    active = []
            try:
                r = G.LOCAL_HTTP.get(base + '/api/care/due', params={'last': int(last_ts * 1000), 'sentToday': sent, 'active': ','.join(active)}, timeout=15)
                due = r.json() or {}
            except Exception:
                continue
            if not due.get('due'):
                reason = str(due.get('reason') or 'unknown')
                tips = {'disabled': '主动搭话总开关是关的', 'out_of_window': '现在不在允许的时间段里', 'too_soon': '离上次主动搭话还不够久', 'daily_cap': '今天的次数用完了', 'all_busy': '白名单里的人最近都在聊，先不打扰', 'whitelist_empty': '白名单是空的，也没有主人 wxid', 'whitelist_filtered': '白名单被三个开关全筛掉了（只找主人 / 允许别人 / 允许群）'}
                G.log_throttled('care-' + reason, '主动搭话没发：' + tips.get(reason, '原因 ' + reason), ttl=1800)
                continue
            target = due.get('target') or {}
            u = str(target.get('wxid') or '').strip()
            name = str(target.get('name') or u).strip()
            if not u:
                continue
            try:
                r2 = G.LOCAL_HTTP.get(base + '/api/care', params={'chat': u}, timeout=40)
                text = str((r2.json() or {}).get('text') or '').strip()
            except Exception as e:
                G.log('生成搭话失败：', repr(e))
                continue
            if not text:
                continue
            G.log('主动搭话 →', name, text[:30])
            try:
                ok = self.send_text(text, name, u)
                save_state({'lastTs': G.time.time(), 'day': today, 'count': sent + (0 if ok is False else 1)})
            except Exception as e:
                G.log('主动搭话发送失败：', repr(e))
                save_state({'lastTs': G.time.time(), 'day': today, 'count': sent})

    def battery_watch(self):
        while True:
            G.time.sleep(30)
            try:
                import psutil
                b = psutil.sensors_battery()
            except Exception:
                continue
            if not b or b.percent is None:
                continue
            pct = float(b.percent)
            if pct > 10:
                self.BATTERY_SENT['done'] = False
                continue
            if pct <= G.LOW_BATTERY_PCT and (not self.BATTERY_SENT['done']):
                self.BATTERY_SENT['done'] = True
                G.log('电量低（%.0f%%），给最近 3 个会话发晚安' % pct)
                try:
                    for u, name in self.recent_chats(limit=3, within=86400):
                        self.send_text(G.GOODNIGHT_TEXT, name, u, force=True)
                        G.time.sleep(0.4)
                except Exception as e:
                    G.log('发晚安失败：', repr(e))

    def ensure_uia_ready(self, force=False):
        """挑「PID 里真有 Weixin.dll」的窗口并按真判据物化 UIA。

        修的是这三件事：过期 hwnd 被当成微信主窗（日志里那个不存在的 PID）、
        第三方库只看根窗口类名就判成功、以及版本表没有 4.2.0.9 时候选 RVA 试错。
        结果缓存 30 秒，避免每次发送都扫一遍。
        """
        if G.uia_boot is None:
            return self._UIA_READY
        now = G.time.time()
        if not force and now - self._UIA_READY['ts'] < 30:
            return self._UIA_READY
        prefer = 0
        try:
            prefer = int(self.ACCOUNT.get('hwnd') or 0)
        except Exception:
            prefer = 0
        try:
            res = G.uia_boot.ensure(prefer_hwnd=prefer, log=G.log)
        except Exception as e:
            res = {'ok': False, 'reason': 'exception: %r' % (e,)}
        try:
            msg = G.uia_boot.describe(res)
        except Exception:
            msg = 'UIA 自检失败'
        self._UIA_READY.update({'ts': now, 'ok': bool(res.get('ok')), 'msg': msg, 'res': res})
        if res.get('ok'):
            h = int(res.get('hwnd') or 0)
            if h and h != prefer and self.ACCOUNT.get('verified'):
                self.ACCOUNT['hwnd'] = h
            G.log('发送通道预热：' + msg)
        else:
            G.log('发送通道预热：' + msg)
        return self._UIA_READY

    def explain_uia_failure(self):
        """UIA 拿不到时把原因说清楚（先用 uia_boot 的真判据，再退老的分支分析）。"""
        if G.uia_boot is not None:
            try:
                r = self.ensure_uia_ready(force=True)
                if r.get('ok'):
                    return
            except Exception:
                pass
        return self._explain_uia_failure_detail()

    def _explain_uia_failure_detail(self):
        """UIA 拿不到时把原因说清楚。

        「热激活 UIA 失败」有三种完全不同的原因，光看那一句没法修：
          A. 主窗所在进程里枚举不到 Weixin.dll（挑到子进程 / 权限 / 微信刚重启）
          B. 这个微信版本库还不支持（特征扫描没命中、版本表里也没有）
          C. 补丁写进去了但 mmui 控件没出现（校验失败，已回滚）
        """
        try:
            import win32process
            from wechatauto.accessibility import AccessibilityGate, QACCESSIBLE_ACTIVE_RVA_BY_VERSION
        except Exception as e:
            G.log('UIA 诊断不可用：', repr(e))
            return
        hwnd = int(self.ACCOUNT.get('hwnd') or 0) or self.find_weixin_hwnd()
        if not hwnd:
            G.log('UIA 诊断：找不到标题为「微信」的主窗（微信缩在托盘？先点开它）')
            return
        try:
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            mods = list(AccessibilityGate._process_modules(pid) or [])
        except Exception as e:
            G.log('UIA 诊断：枚举模块失败：', repr(e))
            return
        dll = None
        for _b, _s, name, path in mods:
            if (name or '').lower() == 'weixin.dll':
                dll = path
                break
        if not dll:
            G.log('UIA 诊断（原因A）：主窗进程 pid=%s 里只有 %d 个模块，枚举不到 Weixin.dll' % (pid, len(mods)))
            G.log('    → 多见于：微信刚重启、主窗属于子进程、或与微信权限不一致')
            return
        ver = G.os.path.basename(G.os.path.dirname(dll))
        try:
            cands = AccessibilityGate._qaccessible_candidate_rvas(dll)
        except Exception as e:
            G.log('UIA 诊断：取候选 RVA 失败：', repr(e))
            return
        known = QACCESSIBLE_ACTIVE_RVA_BY_VERSION.get(ver)
        if not cands:
            G.log('UIA 诊断（原因B）：微信 %s 没有任何可用 gate RVA，这个版本库还不支持' % ver)
            G.log('    → 升级 wechatauto-replica，或换回 4.1.13.65 / 4.1.15.53')
        else:
            G.log('UIA 诊断（原因C）：微信 %s，候选 RVA %d 个（%s），补丁写了但 mmui 没出现' % (ver, len(cands), '版本表命中' if known is not None else '靠特征扫描'))
            G.log('    → 重启微信后立刻重试；仍失败说明该版本的保护变了，等库更新')

    def warmup(self):
        """启动后预热发送通道，避免第一条回复慢 5~10 秒。"""
        G.time.sleep(3)
        try:
            self.ensure_uia_ready(force=True)
            with self.gui_lock:
                if self.gui is None:
                    self.gui = self.WeChatGUI()
            u = self.gui._get_uia()
            self.UIA_CACHE['u'] = u
            if u is None:
                G.log('发送通道预热：UIA 不可用（只剩 OCR 兜底，先跑 examples/uia_selftest.py，它会往文件传输助手发一条）')
                self.explain_uia_failure()
            else:
                win = getattr(u, '_win', None)
                try:
                    wcls = win.ClassName if win is not None else None
                    wname = win.Name if win is not None else None
                except Exception:
                    wcls, wname = (None, None)
                G.log('发送通道预热完成（UIA 可用，主窗类名=%r 名称=%r）' % (wcls, wname))
                try:
                    if self.pick_account_window(quiet=True):
                        if self.ACCOUNT.get('hwnd'):
                            self.rebind_uia(self.ACCOUNT['hwnd'], u)
                        G.log('账号窗口已确认：hwnd=%s（%s）' % (self.ACCOUNT.get('hwnd'), self.ACCOUNT.get('why') or ''))
                    else:
                        G.log('⚠️ 账号窗口没确认（%s）：发送会先被拦下来，直到能认出来' % (self.ACCOUNT.get('why') or '未知'))
                except Exception as e:
                    G.log('账号窗口识别失败：', repr(e))
        except Exception as e:
            G.log('发送通道预热失败：', repr(e))

    def send_watchdog(self):
        """发送卡住超过预算就重启桥接，避免整个队列卡死。

        预算不再是「固定 40 秒」（H3）：bg 通道逐字投递，长文本单打字就要一两分钟，
        一刀切会把合法慢发送当卡死杀掉（半截草稿留在输入框、重启后不补发）。
        预算 = max(40 秒, 0.12 秒 × 文本长度)，随每次发送在 SEND_STATE 里更新；
        各通道进入时还会刷新 SEND_STATE["start"] 当进度心跳。
        """
        while True:
            G.time.sleep(5)
            _budget = float(G.SEND_STATE.get('budget') or 40)
            if G.SEND_STATE['active'] and G.time.time() - G.SEND_STATE['start'] > _budget:
                G.log('发送卡住超过 %.0f 秒，强制重启桥接进程…' % _budget)
                G.time.sleep(0.3)
                G.os._exit(7)

    def listener_alive(self):
        """收消息的轮询线程是否还活着。"""
        try:
            th = getattr(self.listener, '_thread', None)
            return bool(th is not None and th.is_alive())
        except Exception:
            return False

    def listener_watch(self):
        """轮询线程死了就把它拉起来。

        症状：桥接进程还在（心跳正常）、微信里发消息也进来了，但一条都不回复 ——
        因为读数据库的那个线程悄悄退出了。以前只能重启桥接。
        """
        misses = 0
        while True:
            G.time.sleep(15)
            if self.listener_alive():
                misses = 0
                continue
            misses += 1
            if misses < 2:
                continue
            G.log('[!] 收消息线程已经不在了，自动重启监听…')
            try:
                self.listener.start()
                if self.listener_alive():
                    G.log('监听已重启，继续收消息')
                else:
                    G.log('监听重启后仍未启动，建议重启桥接')
            except Exception as e:
                G.log('监听重启失败：', repr(e))
            misses = 0

    def bridge_heartbeat(self):
        """每 20 秒告诉服务端「桥接还活着、UIA/ffmpeg 状态如何」。

        没有心跳时，服务端只知道「它收到了消息」，不知道回复到底有没有能力发出去；
        网页上也就没法提示「桥接离线」或「UIA 不可用」。
        """
        import shutil as _shutil
        base = self.bot_url.rsplit('/webhook', 1)[0]
        misses = 0
        gate_logged = False
        hb_misses = 0
        while True:
            try:
                resting = False
                uia_now = None
                if not resting and G.SEND_STATE.get('active'):
                    G.log('心跳跳过预热（正在发送中）')
                    uia_now = self.UIA_CACHE.get('u') is not None
                elif not resting:
                    try:
                        if not self.wechat_window_alive():
                            with self.gui_lock:
                                self.gui = None
                                self.UIA_CACHE['u'] = None
                            misses = 0
                            uia_now = False
                            if not gate_logged:
                                G.log_warn('[!] 微信主窗当前不存在（可能缩进托盘/被回收/自更新），已收起 UIA 引擎，等窗口回来再预热')
                                gate_logged = True
                        else:
                            with self.gui_lock:
                                _u = self.gui._get_uia() if self.gui is not None else None
                            if _u is None:
                                _ready = self.ensure_uia_ready(force=True)
                                if _ready.get('ok'):
                                    with self.gui_lock:
                                        self.gui = self.WeChatGUI()
                                        _u = self.gui._get_uia()
                                    if _u is not None:
                                        misses = 0
                                        gate_logged = False
                                if _u is None:
                                    misses += 1
                                if _u is None and misses >= 3:
                                    G.log_warn('[!] UIA 连续 %d 次拿不到，重建窗口驱动再试…' % misses)
                                    with self.gui_lock:
                                        self.gui = self.WeChatGUI()
                                        _u = self.gui._get_uia()
                                    if _u is not None:
                                        misses = 0
                            else:
                                misses = 0
                                gate_logged = False
                            self.UIA_CACHE['u'] = _u
                            uia_now = _u is not None
                    except Exception:
                        uia_now = self.UIA_CACHE.get('u') is not None
                payload = {'platform': 'wechat', 'uia': uia_now, 'rest': resting, 'listener': self.listener_alive(), 'ffmpeg': bool(_shutil.which('ffmpeg')), 'account': self.db.account, 'account_wxid': self.db.wxid, 'account_nick': self._self_nick, 'account_ok': bool(self.ACCOUNT.get('verified')), 'account_why': str(self.ACCOUNT.get('why') or ''), 'account_guard': bool(G.ACCOUNT_GUARD), 'window': self.wechat_window_state()}
                headers = {'x-whale-bridge': '1'}
                if self.token:
                    headers['x-bot-token'] = self.token
                G.LOCAL_HTTP.post(base + '/api/bridge/heartbeat', json=payload, headers=headers, timeout=8)
                if hb_misses:
                    G.log_warn('心跳恢复（之前连续失败 %d 次，服务端已回来）' % hb_misses)
                    hb_misses = 0
            except Exception as e:
                hb_misses += 1
                if hb_misses in (1, 3, 10) or hb_misses % 60 == 0:
                    G.log_warn('心跳失败（连续 %d 次，服务端可能没起来）：%r' % (hb_misses, e))
            G.time.sleep(20)

    def config_watch(self):
        """盯 config.json 的修改时间：调试台一保存就热更新，不用重启桥接。

        以前这些开关只在启动时读一次，用户在 /debug 里关掉「主动搭话」、
        改「忽略名单」、「群聊开关」都没反应，只能重启桥接 —— 也就是
        「调了没用，还是默认」。
        """
        last = G.CONFIG_MTIME_AT_START
        while True:
            G.time.sleep(5)
            try:
                mt = G.os.path.getmtime(G.CONFIG_PATH)
            except Exception:
                continue
            if mt == last:
                continue
            last = mt
            current = G.read_config()
            if str(((current.get('gateway') or {}).get('wechat') or {}).get('inboundToken') or '') != str(self.token or '') or str((current.get('wechat') or {}).get('dbDir') or '') != str((self.cfg.get('wechat') or {}).get('dbDir') or '') or G.build_bot_url(current) != self.bot_url:
                G.log('桥接连接设置变了，重新连接微信与内核…')
                G.os._exit(7)
            if G.reload_config():
                G.log('配置已热更新（调试台改完即时生效，不用重启桥接）')

    def contacts_sync_once(self):
        """把「联系人 + 群」清单推给服务端一次（H1 接线；后台线程跑完即退）。

        bridge/contacts_sync.py 只负责从 DB 整理数据；推送（POST
        /api/wechat/contacts/sync）在这里做。失败只记日志：清单丢一轮只影响
        网页选择器的候选，绝不影响收发消息。
        """
        try:
            try:
                import contacts_sync
            except Exception:
                from . import contacts_sync
            data = contacts_sync.payload(self.db, int(G.time.time() * 1000))
            headers = {'x-whale-bridge': '1'}
            if self.token:
                headers['x-bot-token'] = self.token
            base = self.bot_url.rsplit('/webhook', 1)[0]
            r = G.LOCAL_HTTP.post(base + '/api/wechat/contacts/sync', json=data, headers=headers, timeout=15)
            code = getattr(r, 'status_code', 0)
            G.log('联系人同步：%s（%d 条%s）' % ('成功' if code == 200 else '失败 HTTP %s' % code, len(data.get('items') or []), '，账号 ' + str(data.get('account') or '') if data.get('account') else ''))
        except Exception as e:
            G.log('联系人同步失败（不影响收发消息）：', repr(e))

    def start_reminder_watch(self):
        """构造提醒调度器并启动它的线程（H1 接线）。

        ReminderRunner（bridge/reminder_watch.py）依赖全部注入：
          fetch → GET  /api/reminders/due（到点的 + 下一条时间）
          send  → send_text 发到提醒所属会话
          ack   → POST /api/reminders/ack（回执；失败由服务端 5 分钟后重试）
        实例存模块级 REMINDER_RUNNER，退出分支（KeyboardInterrupt）能拿到它。
        """
        try:
            try:
                from reminder_watch import ReminderRunner
            except Exception:
                from .reminder_watch import ReminderRunner
            base = self.bot_url.rsplit('/webhook', 1)[0]
            headers = {'x-whale-bridge': '1'}
            if self.token:
                headers['x-bot-token'] = self.token

            def _fetch_due():
                r = G.LOCAL_HTTP.get(base + '/api/reminders/due', headers=headers, timeout=10)
                return r.json() if getattr(r, 'status_code', 0) == 200 else {}

            def _send_due(item, text):
                wxid = str(item.get('wxid') or '').strip()
                name = str(item.get('name') or '').strip() or self.display_name(wxid)
                return bool(self.send_text(text, name, wxid))

            def _ack_due(item, ok, err):
                try:
                    G.LOCAL_HTTP.post(base + '/api/reminders/ack', json={'id': item.get('id'), 'ok': bool(ok), 'error': str(err or '')}, headers=headers, timeout=10)
                except Exception as e:
                    G.log('提醒回执没送到（服务端会自己重试）：', repr(e))
            G.REMINDER_RUNNER = ReminderRunner(fetch=_fetch_due, send=_send_due, ack=_ack_due, log=G.log)
            G.threading.Thread(target=G.REMINDER_RUNNER.run, daemon=True, name='reminder-watch').start()
            G.log('提醒调度已启动（到点准点发）')
            return G.REMINDER_RUNNER
        except Exception as e:
            G.log('提醒调度启动失败（提醒停用，不影响收发）：', repr(e))
            return None
