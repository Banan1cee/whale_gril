# -*- coding: utf-8 -*-
"""wechatauto 小版本兼容补丁：修「微信明明开着，UIA 却永远不可用」。

现场（本机 2026-10-23 实测，pid 29208）
--------------------------------------
wechatauto-replica 1.2.7.0 认微信主窗要同时满足四个条件，本机一个都不满足：

    _wechat_hwnds()   # uia_driver.py:355
      if win32gui.IsWindowVisible(h) and _title_is_main(title):      # ①要可见 ②标题含「微信/Weixin」
          if self._weixin_dll_module(pid):                            # ③进程里得有 Weixin.dll
    _find_main()      # uia_driver.py:402
      if (c.ClassName or "") in ("mmui::MainWindow",):                # ④顶层类名必须是它

实测这台机器：

    hwnd 527732  pid 29208  class=Qt51514QWindowIcon  title='哦鲸鲸'  visible=0   ← 真正的主窗
    hwnd 462296  pid 29208  class=Qt51514QWindowIcon  title='Weixin'  visible=0
    hwnd 1249038 pid 29208  class=Qt51514QWindowToolSaveBits  title='Weixin'  visible=0

① 主窗在托盘里时 visible=0 → 直接被 `IsWindowVisible` 筛掉；
② 主窗标题是**账号昵称**（哦鲸鲸），不是「微信/Weixin」→ `_title_is_main` 不认；
④ 顶层类名是 Qt 外壳 `Qt51514QWindowIcon`，不是 `mmui::MainWindow`
   （日志里 gate 明明写成功了：`UIA 树已物化，已记录 gate RVA：Weixin.dll+0xb134c38`，
    说明 mmui 子控件已经长出来了，只是**顶层**没改名）。

后果：`_get_uia()` 永远拿到 None → 桥接每次发送都跳过 UIA、掉进 OCR 兜底 →
卡死在 PIL ImageGrab.grab 截屏里（data/bridge-hang.log 抓到栈）→ 40 秒后看门狗
os._exit(2) 重启，循环往复。

补丁做了什么
------------
1) `_wechat_hwnds()`：改成**按进程找窗**——枚举所有顶层窗口，按「面积够大 + 该进程
   加载了 Weixin.dll」筛，不再看标题，也不再要求可见（托盘里的主窗照样能被认出来，
   `_activate()` 里的 ShowWindow(SW_SHOW) 会把它拉出来）。模块枚举结果做 5 秒缓存，
   避免每次枚举 500 多个窗口都去拍进程快照。
2) `_find_main()`：类名对得上照旧；对不上时看这个窗口里有没有 mmui:: 子控件——
   有就说明树已物化（正是本机的情况）。没物化的窗口行为不变。
3) `_weixin_dll_module()`：加 4 次重试（模块枚举本身会抖，日志里反复出现
   「扫到 1 个微信窗口，但每个都定位不到 Weixin.dll 模块」）。
4) 兜底：一个窗口都扫不到时，按「标题含微信/Weixin」再扫一轮。

用法
----
    import uia_compat
    uia_compat.apply()

放在 `import wechatauto` 之后、第一次 `WeChatGUI()` 之前执行即可，多次调用幂等。
"""

from __future__ import annotations

import logging
import os
import re
import threading
import time

log = logging.getLogger("wechatauto.uia_compat")

_APPLIED = False
_seen_logged = set()
# 当前正在跑的 UIA 步骤（卡死时靠它看停在哪一步）。只有设了 WHALE_STEPLOG 才逐条记日志。
_STEP = {"name": None, "since": 0.0}


def current_step():
    """返回 (步骤名, 已耗时秒)。没在跑任何步骤时返回 (None, 0.0)。"""
    name = _STEP.get("name")
    if not name:
        return (None, 0.0)
    return (name, time.time() - float(_STEP.get("since") or 0.0))

# 只认「像主窗」的窗口：面积至少 300x250。托盘里的主窗仍保留原尺寸，所以照样命中；
# 而 260x85 的 tool-tip 窗、173x196 的辅助窗会被漏掉。
_HWND_AREA_MIN = 300 * 250
# 「长得像微信」的顶层窗口类名前缀（小写）：本机主窗是 Qt 5.15.14 外壳
# `Qt51514QWindowIcon`；gate 生效的版本是 `mmui::MainWindow`。未知版本会掉到下面
# 的 Weixin.dll 探测兜底。
_WECHAT_CLS_HINTS = ("qt51514", "mmui::", "wechat")
# 兜底探测的规模上限：最多看 50 个大窗口、最多拍 8 个进程快照，避免每次枚举都几十秒。
_MAX_PROBE_WINDOWS = 50
_MAX_DLL_PROBES = 8
# Weixin.dll 模块枚举结果缓存：pid -> (时间戳, 模块对象或 None)
_DLL_CACHE = {}
_DLL_TTL = 5.0


def _note_once(kind: str, hwnd: int, detail: str) -> None:
    """同一类「意外但已修好」的情况每个窗口只吼一次，别把日志刷爆。"""
    key = (kind, int(hwnd))
    if key in _seen_logged:
        return
    _seen_logged.add(key)
    log.warning("uia_compat: %s", detail)


def _dll_module_cached(owner, pid, ttl: float = _DLL_TTL):
    now = time.time()
    hit = _DLL_CACHE.get(pid)
    if hit is not None and (now - hit[0]) < ttl:
        return hit[1]
    try:
        mod = owner._weixin_dll_module(pid)      # 走打过重试补丁的版本
    except Exception:                            # noqa: BLE001
        mod = None
    _DLL_CACHE[pid] = (now, mod)
    return mod


def apply(verbose: bool = True) -> bool:
    """打补丁（幂等）。wechatauto 没装时返回 False，不抛异常。"""
    global _APPLIED
    if _APPLIED:
        return True
    try:
        from wechatauto import uia_driver as ud
    except Exception as e:                       # noqa: BLE001
        log.debug("uia_compat: 没有可用的 wechatauto，跳过：%s", e)
        return False

    cls = ud.WeChatUIA
    if getattr(cls, "_whale_compat", False):
        _APPLIED = True
        return True

    main_classes = tuple(getattr(ud, "MAIN_CLASSES", ("mmui::MainWindow",)))
    title_is_main = ud._title_is_main

    # ① 模块枚举加重试 -------------------------------------------------------
    try:
        gate = ud._acc.AccessibilityGate
        orig_dll = gate.__dict__["_weixin_dll_module"].__func__
    except Exception:                            # noqa: BLE001
        orig_dll = None

    if orig_dll is not None:
        def _dll_with_retry(kls, pid, _orig=orig_dll):
            for i in range(4):
                mod = _orig(kls, pid)
                if mod:
                    return mod
                if i < 3:
                    time.sleep(0.15)
            return None

        gate._weixin_dll_module = classmethod(_dll_with_retry)
        # WeChatUIA 上的同名转发是 lambda 里现查 AccessibilityGate，自动跟着变。

    # ② 找主窗：不看标题、不要求可见 -----------------------------------------
    # 先按「长得像微信」的类名/标题筛（纯 Win32 查询，毫秒级）；一个都没筛出来时
    # 才去拍进程快照查 Weixin.dll——那步慢（受限令牌下还常失败），不能放在热路径上。
    def _looks_wechat(cls: str, title: str) -> bool:
        c = (cls or "").lower()
        if c.startswith(_WECHAT_CLS_HINTS) or "weixin" in c or "wechat" in c:
            return True
        return bool(title_is_main(title or ""))

    def _wechat_hwnds(self, diag=None):
        has_win32 = bool(getattr(ud, "_HAS_WIN32", True))
        if diag is not None:
            diag.update({'win32': has_win32, 'matched': 0, 'kept': 0,
                         'dropped_no_dll': 0})
        if not has_win32:
            return []
        try:
            import win32gui
        except Exception:                        # noqa: BLE001
            return []

        rows = []                                # (面积, hwnd, 类名, 标题, 像不像微信)

        def _rect_of(h):
            """最小化后的窗口 GetWindowRect 是 (-16000,-16000,…) 这种退化矩形，
            按面积过滤会把它当小窗丢掉——所以先问 GetWindowPlacement 要「还原后」
            的位置，取不到再退回 GetWindowRect。"""
            try:
                if win32gui.IsIconic(h):
                    try:
                        rc = win32gui.GetWindowPlacement(h)[4]
                        if rc and rc[2] > rc[0] and rc[3] > rc[1]:
                            return tuple(rc)
                    except Exception:            # noqa: BLE001
                        pass
                return tuple(win32gui.GetWindowRect(h))
            except Exception:                    # noqa: BLE001
                return (0, 0, 0, 0)

        def _cb(h, _):
            try:
                l, t, r, b = _rect_of(h)
                area = max(0, r - l) * max(0, b - t)
                title = win32gui.GetWindowText(h) or ""
                cls = win32gui.GetClassName(h) or ""
                if area < _HWND_AREA_MIN and not title_is_main(title):
                    return True
                if diag is not None:
                    diag['matched'] += 1
                rows.append((area, int(h), cls, title, _looks_wechat(cls, title)))
            except Exception:                    # noqa: BLE001
                pass
            return True

        try:
            win32gui.EnumWindows(_cb, None)
        except Exception:                        # noqa: BLE001
            pass

        hits = [(a, h) for a, h, _c, _t, ok in rows if ok]
        if hits:
            hits.sort(reverse=True)              # 面积大的在前 = 主聊天窗
            if diag is not None:
                diag['kept'] = len(hits)
            return [h for _, h in hits]

        # 兜底：类名/标题都不像微信（换了 UI 框架的版本）→ 按 pid 查 Weixin.dll
        probed, cache, out = 0, {}, []
        for area, h, _c, _t, _ok in sorted(rows, reverse=True)[:_MAX_PROBE_WINDOWS]:
            try:
                pid = self._pid_from_hwnd(h)
            except Exception:                    # noqa: BLE001
                pid = 0
            if not pid:
                continue
            if pid not in cache:
                if probed >= _MAX_DLL_PROBES:
                    continue
                probed += 1
                cache[pid] = bool(_dll_module_cached(self, pid))
            if cache[pid]:
                out.append((area, h))
            elif diag is not None:
                diag['dropped_no_dll'] += 1
        out.sort(reverse=True)
        if diag is not None:
            diag['kept'] = len(out)
        return [h for _, h in out]

    # ③ _find_main：类名对不上时改用「树已物化 + 有聊天界面」判断 ------------
    # v5：21:26 的教训——微信还挂着一个 mmui::LoginWindow（隐藏的登录窗，同样有
    # mmui 子控件），按面积排它在真主窗前面，于是 _find_main 把登录窗当主窗返回，
    # 之后 open_chat 在登录窗的树里找不到会话列表（日志：会话列表里没有 …）。
    # 现在分三步：类名严格匹配 → 排除登录窗且子树里真有会话列表/输入框 → 退让。
    def _has_chat_ui(self, ctrl, max_depth=12, budget=2.0):
        """这个窗口的 UIA 子树里有没有聊天界面（会话列表 / 输入框 / 导航栏）。"""
        deadline = time.time() + budget
        stack = [(ctrl, 0)]
        while stack and time.time() < deadline:
            node, depth = stack.pop()
            if depth >= max_depth:
                continue
            try:
                kids = node.GetChildren()
            except Exception:                    # noqa: BLE001
                continue
            for k in kids:
                try:
                    aid = k.AutomationId or ""
                except Exception:                # noqa: BLE001
                    aid = ""
                try:
                    cls = k.ClassName or ""
                except Exception:                # noqa: BLE001
                    cls = ""
                if aid in ("session_list", "chat_input_field") or cls == "mmui::MainTabBar":
                    return True
                if cls.startswith("mmui::X") or depth < 4:
                    stack.append((k, depth + 1))
        return False

    def _find_main(self):
        try:
            hwnds = list(self._wechat_hwnds() or ())
        except Exception:                        # noqa: BLE001
            hwnds = []

        cands = []
        # 第一步：和原来一致（类名严格匹配优先）
        for h in hwnds[:16]:
            try:
                c = self._anchor(h)
            except Exception:                    # noqa: BLE001
                c = None
            if c is None:
                continue
            try:
                cls = c.ClassName or ""
            except Exception:                    # noqa: BLE001
                cls = ""
            if cls in main_classes:
                return c
            cands.append((h, c, cls))

        # 第二步：类名对不上（本机就是），但登录窗一律不要；要求子树里真有聊天界面
        for h, c, cls in cands:
            if "login" in cls.lower():
                continue
            try:
                if not self._mmui_present(h, timeout=0.5):
                    continue
                if self._has_chat_ui(c):
                    _note_once(
                        "chatui", h,
                        "主窗 hwnd=%s 类名=%r：子树里有会话列表/输入框，认定为主窗" % (h, cls))
                    return c
            except Exception:                    # noqa: BLE001
                continue

        # 第三步：没有能确认聊天界面的，退而求其次（仍旧排除登录窗）
        for h, c, cls in cands:
            if "login" in cls.lower():
                continue
            try:
                if self._mmui_present(h, timeout=0.5):
                    _note_once(
                        "materialized", h,
                        "主窗 hwnd=%s 类名=%r（没能确认聊天界面），按「已物化」放行" % (h, cls))
                    return c
            except Exception:                    # noqa: BLE001
                continue

        # 第四步：只剩登录窗 → 明确失败（这时候微信就在登录页，发送不可能成功）
        for h, _c, cls in cands:
            if "login" in cls.lower():
                _note_once("login-only", h,
                           "只找到登录窗 hwnd=%s（%r）：微信还停在登录页，先手动登录再发" % (h, cls))
                break

        # 第五步：一个窗口都没扫到 → 按标题再扫一轮（模块枚举抖动的兜底）
        if not hwnds:
            try:
                import win32gui
                extra = []

                def _cb2(h, _):
                    try:
                        if title_is_main(win32gui.GetWindowText(h) or ""):
                            extra.append(int(h))
                    except Exception:            # noqa: BLE001
                        pass
                    return True

                win32gui.EnumWindows(_cb2, None)
            except Exception:                    # noqa: BLE001
                extra = []
            for h in extra:
                try:
                    c = self._anchor(h)
                    if c is not None and self._mmui_present(h, timeout=0.5):
                        _note_once(
                            "title", h,
                            "主窗 hwnd=%s 是按标题兜底找到的（进程扫描没命中）" % (h,))
                        return c
                except Exception:                # noqa: BLE001
                    continue
        return None

    # ④ 打开会话：优先在「会话列表」里直接点，绕开搜索框那条老路 ------------
    # 原 open_chat 走「搜索框 → 等搜索结果」：4.1.15+ 的搜索入口是收起的，
    # _search_box(expand=True) 要先点一下按钮把它展开；展开失败就 return False，
    # 而 _find_search_list() 会拿**整个桌面**根节点按 25 层深度找 ListControl
    # （日志里这一步能卡几十秒）。会话列表的 AutomationId 本机一直稳（session_list），
    # 直接点比搜可靠得多——机器人回消息时那个会话本来就在列表最上面。
    orig_open_chat = cls.open_chat
    _aid_hit = getattr(ud, "_aid_hit", None)
    _find_by = getattr(ud, "_find_by", None)
    _session_aids = tuple(getattr(ud, "SESSION_LIST_AIDS", ("session_list",)))

    def _norm_name(text):
        head = (text or "").split("\n", 1)[0].strip()
        # 「群名（12）」「群名(12)」这种未读数后缀，别让它挡住名字匹配
        m = re.match(r"^(.*?)\s*[（(]\s*\d+\s*[）)]\s*$", head)
        if m and m.group(1).strip():
            return m.group(1).strip()
        return head

    def _session_list(self, win=None):
        """会话列表控件本身（找不到返回 None）。"""
        win = win if win is not None else getattr(self, "_win", None)
        if win is None:
            return None
        for aid in _session_aids:
            for meth in ("ListControl", "CustomControl", "PaneControl"):
                try:
                    c = getattr(win, meth)(AutomationId=aid)
                except Exception:                # noqa: BLE001
                    continue
                try:
                    if c is not None and c.Exists(0.3, 0.1):
                        return c
                except Exception:                # noqa: BLE001
                    continue
        if _find_by is not None and _aid_hit is not None:
            try:
                return _find_by(
                    win,
                    lambda c: _aid_hit(getattr(c, "AutomationId", "") or "", _session_aids),
                    max_depth=30)
            except Exception:                    # noqa: BLE001
                return None
        return None

    def _session_rows(self, win=None, max_rows: int = 40):
        """会话列表里当前能看到的行：[(名字, 控件), ...]（自上而下）。"""
        win = win if win is not None else getattr(self, "_win", None)
        if win is None:
            log.warning("uia_compat: 会话列表：主窗还没拿到")
            return []
        lst = _session_list(self, win)
        if lst is None:
            log.warning("uia_compat: 会话列表：主窗里找不到 session_list 锚点")
            return []

        # 列表里的行常常隔一层容器，所以按「层」找：第一层有名字的节点就是行
        level = [lst]
        for _depth in range(4):
            nxt, named = [], []
            for node in level:
                try:
                    kids = node.GetChildren()
                except Exception:                # noqa: BLE001
                    continue
                for k in kids:
                    nxt.append(k)
                    try:
                        nm = (k.Name or "").strip()
                    except Exception:            # noqa: BLE001
                        nm = ""
                    if nm:
                        named.append((_norm_name(nm), k))
            if named:
                if len(named) > max_rows:
                    named = named[:max_rows]
                return named
            level = nxt
            if not level:
                break
        log.warning("uia_compat: 会话列表：找到 session_list 但一行带名字的都没有")
        return []

    def _fallback_open(self, keyword, index, section, retries, timeout=15.0):
        """搜索框老路很脆（会卡几十秒），放线程里跑，超时就放弃这一条。"""
        box = {}

        def _run():
            try:
                box["r"] = orig_open_chat(self, keyword, index, section, retries)
            except Exception as e:               # noqa: BLE001
                box["e"] = e

        th = threading.Thread(target=_run, daemon=True, name="whale-open-chat")
        th.start()
        th.join(timeout)
        if th.is_alive():
            log.warning("uia_compat: 搜索框兜底 %.0f 秒没返回（卡住了），放弃这条", timeout)
            return False
        if "e" in box:
            log.warning("uia_compat: 搜索框兜底异常：%r", box["e"])
        return bool(box.get("r"))

    def _name_tokens(text):
        return [t.strip() for t in re.split(r"[、,，;；/]", text or "") if t.strip()]

    def _row_score(nm, aliases):
        """这个列表行名和一串候选名有多像：0 最像，数字越大越勉强，None 不匹配。

        微信里**没命名**的群，会话列表显示的是成员名（「宇火之于、云白『世一区』」），
        跟数据库里的群名（空）和群 id 都对不上，所以按「成员名集合」比一次（score 1）。
        """
        if not nm:
            return None
        for al in aliases:
            if al and nm == al:
                return 0
        ntok = _name_tokens(nm)
        if len(ntok) >= 2:
            for al in aliases:
                atok = _name_tokens(al)
                if atok and all(t in atok for t in ntok):
                    return 1
        for al in aliases:
            if not al:
                continue
            if nm.startswith(al) or al.startswith(nm) or al in nm or nm in al:
                return 2
        return None

    def open_chat(self, keyword, index=None, section=None, retries=2):  # noqa: D401
        """keyword 可以是名字，也可以是一串候选名（list/tuple）。"""
        if not self.ensure_window():
            return False
        if isinstance(keyword, (list, tuple, set)):
            aliases = [str(x or "").strip() for x in keyword]
        else:
            aliases = [str(keyword or "").strip()]
        aliases = [a for a in aliases if a]
        if not aliases:
            return False
        target = aliases[0]
        try:
            if not self.back_to_chat_tab():
                log.warning("uia_compat: 没能确认回到聊天页，仍然在会话列表里找")
        except Exception as e:                   # noqa: BLE001
            log.warning("uia_compat: back_to_chat_tab 异常：%s", e)
        try:
            self._force_foreground(self._win)
        except Exception:                        # noqa: BLE001
            pass

        rows = _session_rows(self)
        if rows:
            log.info("uia_compat: 会话列表 %d 项：%s", len(rows),
                     " | ".join(n[:16] for n, _c in rows[:8]))
        scored = []
        for nm, ctrl in rows:
            sc = _row_score(nm, aliases)
            if sc is None:
                continue
            scored.append((sc, abs(len(nm) - len(target)), nm, ctrl))
        scored.sort(key=lambda x: (x[0], x[1]))
        best = scored[0] if scored else None
        if best is not None and best[0] >= 1:
            # 宽松匹配只允许唯一一名候选，否则宁可放弃（避免点错人）
            same = [x for x in scored if x[0] == best[0] and x[2] != best[2]]
            if same:
                log.warning("uia_compat: 会话列表里有多个像 %r 的行（%s），不猜，回退搜索框",
                            target, " / ".join(x[2][:16] for x in scored[:4]))
                best = None
        if best is not None:
            rank, _dl, nm, ctrl = best
            log.info("uia_compat: 在会话列表里点开 %r（匹配级 %d）", nm, rank)
            try:
                self._click_ctrl(ctrl)
            except Exception as e:               # noqa: BLE001
                log.warning("uia_compat: 点会话行异常：%s", e)
            time.sleep(0.8)
            cur = None
            try:
                cur = self.current_chat()
            except Exception:                    # noqa: BLE001
                cur = None
            if cur and (cur == nm or _row_score(cur, [nm]) == 0):
                log.info("uia_compat: 会话已打开（current_chat=%r）", cur)
                return True
            log.warning("uia_compat: 点了 %r 但 current_chat=%r，回退搜索框", nm, cur)
        else:
            log.info("uia_compat: 会话列表里没有 %r，回退搜索框", target)
        return _fallback_open(self, target, index, section, retries)

    cls.open_chat = open_chat

    # ⑤ 步骤埋点：卡死时能看出停在哪一步（WHALE_STEPLOG=1 才逐条打） ---------
    step_names = ("ensure_window", "back_to_chat_tab", "_search_box", "_search_button",
                  "_find_search_list", "_collect_results", "_set_text", "_paste_into",
                  "_click_ctrl", "current_chat", "_chat_input", "open_chat", "send_text")
    verbose_steps = bool(os.environ.get("WHALE_STEPLOG"))
    for name in step_names:
        orig = getattr(cls, name, None)
        if orig is None or getattr(orig, "_whale_step", False):
            continue

        def _make(orig=orig, name=name):
            def _wrapped(self, *a, **kw):
                prev = (_STEP["name"], _STEP["since"])
                _STEP["name"], _STEP["since"] = name, time.time()
                t0 = time.time()
                try:
                    return orig(self, *a, **kw)
                finally:
                    _STEP["name"], _STEP["since"] = prev
                    if verbose_steps:
                        log.info("uia step %s -> %.2fs", name, time.time() - t0)
            _wrapped._whale_step = True
            return _wrapped

        setattr(cls, name, _make())

    cls._wechat_hwnds = _wechat_hwnds
    cls._find_main = _find_main
    cls._has_chat_ui = _has_chat_ui
    cls._session_list = _session_list
    # 方便单独测「这句话该点哪一行」，不碰任何窗口
    cls._row_score = staticmethod(_row_score)
    cls._name_tokens = staticmethod(_name_tokens)
    cls._whale_compat = True
    _APPLIED = True
    if verbose:
        log.warning(
            "uia_compat: 补丁已生效（按进程找窗 + 类名不是 %s 时看 mmui 子控件）",
            "、".join(main_classes))
    return True
