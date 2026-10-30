# -*- coding: utf-8 -*-
"""鲸鲸 · 微信发送通道自检（UIA 这条路）

双击项目根目录的「一键修复并自检.bat」就会跑这个脚本。它做五件事：

  1. 列出微信进程的所有窗口（含托盘/最小化，标题可能是账号昵称）
  2. 把主窗从托盘/最小化状态「还原 + 摆到固定尺寸」
     —— 最小化时 Qt 不会建控件树，这是发不出去的第二个坑
  3. 打 uia_compat 补丁，看 UIA 能不能认出微信主窗
  4. 把控件树导出（data/uia-tree.txt），并检查搜索框/会话列表/输入框锚点
  5. 给「文件传输助手」发一条测试消息，再回读数据库确认真的发出去了

日志：data/uia-selftest.log（控件树：data/uia-tree.txt）
"""

from __future__ import annotations

import ctypes
import logging
import os
import sys
import threading
import time
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

os.environ.setdefault("WECHATAUTO_RHYTHM", "off")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
# 逐条打印 UIA 步骤耗时：卡死时能直接看出停在哪一步
os.environ["WHALE_STEPLOG"] = "1"

LOG_PATH = os.path.join(ROOT, "data", "uia-selftest.log")
TREE_PATH = os.path.join(ROOT, "data", "uia-tree.txt")
FAULT_PATH = os.path.join(ROOT, "data", "uia-fault.log")
os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)

# 硬崩（comtypes/UIA 里的访问违例不走 Python 异常）也要留下栈，否则日志突然断在这里
# 就没法判断是「卡住」还是「崩了」。
try:
    import faulthandler
    _fault = open(FAULT_PATH, "w", encoding="utf-8")
    faulthandler.enable(file=_fault, all_threads=True)
except Exception:                                # noqa: BLE001
    _fault = None

# 独立 logger：wechatauto 导入时会重新配置 root logger，用 root 的话这份日志会被
# 抢走（上一版就丢了大半输出）。
log = logging.getLogger("whale.selftest")
log.setLevel(logging.INFO)
log.propagate = False
_fmt = logging.Formatter("%(asctime)s %(levelname)-5s %(message)s", "%H:%M:%S")
for _h in (logging.StreamHandler(sys.stdout),
           logging.FileHandler(LOG_PATH, mode="w", encoding="utf-8")):
    _h.setFormatter(_fmt)
    log.addHandler(_h)

# wechatauto 自己的日志也跟着进这份文件，方便一眼看全
_wx = logging.getLogger("wechatauto")
_wx.setLevel(logging.INFO)
_wx_handler = logging.FileHandler(LOG_PATH, mode="a", encoding="utf-8")
_wx_handler.setFormatter(_fmt)
_wx.addHandler(_wx_handler)

PROBLEMS = []
STUCK = []
# 发送这一步整体限时：UIA 卡在某个模式调用上时不会抛异常，只会一直等，
# 不给上限就永远看不到「卡在哪一步」。
SEND_TIMEOUT = 90


def section(title):
    log.info("")
    log.info("========== %s ==========", title)


def fail(msg):
    PROBLEMS.append(msg)
    log.error("✗ %s", msg)


def warn(msg):
    PROBLEMS.append(msg)
    log.warning("! %s", msg)


def bridge_running():
    """桥接进程占着 47821 的单实例锁；能连上说明它还在跑。"""
    import socket
    s = socket.socket()
    s.settimeout(0.5)
    try:
        s.connect(("127.0.0.1", 47821))
        return True
    except Exception:                            # noqa: BLE001
        return False
    finally:
        s.close()


def rect_of(hwnd, win32gui):
    """最小化窗口的 GetWindowRect 是 (-16000,-16000,…)，要问 GetWindowPlacement
    要「还原后」的位置，否则面积判断会把它当小窗丢掉。"""
    try:
        if win32gui.IsIconic(hwnd):
            try:
                rc = win32gui.GetWindowPlacement(hwnd)[4]
                if rc and rc[2] > rc[0] and rc[3] > rc[1]:
                    return tuple(rc)
            except Exception:                    # noqa: BLE001
                pass
        return tuple(win32gui.GetWindowRect(hwnd))
    except Exception:                            # noqa: BLE001
        return (0, 0, 0, 0)


def main():
    section("0. 环境")
    log.info("Python      : %s", sys.version.replace("\n", " "))
    log.info("解释器位数  : %d 位", ctypes.sizeof(ctypes.c_void_p) * 8)
    log.info("项目目录    : %s", ROOT)

    if bridge_running():
        log.error("")
        log.error("先把正在跑的「启动微信桥接」黑窗口关掉再自检——")
        log.error("否则两个程序会一起抢微信窗口，结果不准（单实例锁 47821 还占着）。")
        return 2

    # ---------------------------------------------------------------- 1. 窗口
    section("1. 微信窗口扫描（含托盘/最小化）")
    try:
        import win32gui
        import win32process
    except Exception as e:                       # noqa: BLE001
        log.error("pywin32 不可用，整个 UIA 路线都没法用：%r", e)
        return 3

    rows = []

    def _cb(hwnd, _):
        try:
            title = win32gui.GetWindowText(hwnd) or ""
            try:
                cls = win32gui.GetClassName(hwnd)
            except Exception:                    # noqa: BLE001
                cls = "?"
            low = (title + " " + cls).lower()
            # 微信 4.x 主窗标题是账号昵称（本机是「哦鲸鲸」），托盘里还不可见，
            # 所以这里靠 Win32 类名兜底，别按标题筛。
            if not (("微信" in title) or ("weixin" in low)
                    or cls.lower().startswith("qt51514")):
                return True
            try:
                pid = win32process.GetWindowThreadProcessId(hwnd)[1]
            except Exception:                    # noqa: BLE001
                pid = -1
            try:
                vis = bool(win32gui.IsWindowVisible(hwnd))
                icon = bool(win32gui.IsIconic(hwnd))
            except Exception:                    # noqa: BLE001
                vis = icon = False
            rc = rect_of(hwnd, win32gui)
            rows.append((int(hwnd), pid, cls, title, rc, vis, icon))
        except Exception:                        # noqa: BLE001
            pass
        return True

    win32gui.EnumWindows(_cb, None)
    rows.sort(key=lambda r: -((r[4][2] - r[4][0]) * (r[4][3] - r[4][1])))
    if not rows:
        fail("一个微信窗口都没扫到（按类名 Qt51514 也没扫到）：微信没启动 / 未登录。"
             "把它打开登录好，再跑一次自检。")
    for hwnd, pid, cls, title, rc, vis, icon in rows:
        log.info("hwnd=%-8s pid=%-6s 可见=%d 最小化=%d 类名=%-34s 矩形=%s 标题=%r",
                 hwnd, pid, int(vis), int(icon), cls, rc, title)

    # ------------------------------------------------------- 2. 还原主窗
    section("2. 把主窗摆到正常尺寸（最小化时控件树是空的）")
    main_hwnd = 0
    for hwnd, pid, cls, title, rc, vis, icon in rows:
        low = cls.lower()
        if not low.startswith("qt51514"):
            continue
        if "trayicon" in low or "toolsavebits" in low:   # 托盘提示窗、工具条窗口
            continue
        main_hwnd = hwnd
        break
    if main_hwnd:
        log.info("认作主窗：hwnd=%s", main_hwnd)
        try:
            win32gui.ShowWindow(main_hwnd, 9)             # SW_RESTORE
            time.sleep(0.3)
            win32gui.SetWindowPos(main_hwnd, 0, 40, 20, 1320, 900, 0x0040)  # SWP_SHOWWINDOW
            time.sleep(1.0)
            rc = win32gui.GetWindowRect(main_hwnd)
            log.info("还原后：可见=%d 最小化=%d 矩形=%s",
                     int(win32gui.IsWindowVisible(main_hwnd)),
                     int(win32gui.IsIconic(main_hwnd)), rc)
        except Exception as e:                            # noqa: BLE001
            warn("还原主窗失败：%r" % (e,))
    else:
        warn("没有可用的微信主窗（可能微信完全没打开）")

    # ---------------------------------------------------------------- 3. 补丁
    section("3. 打 uia_compat 补丁并认主窗")
    try:
        import uia_compat
        uia_compat.apply()
    except Exception:                            # noqa: BLE001
        log.error("补丁打不上：%s", traceback.format_exc())
        return 4

    try:
        from wechatauto.uia_driver import WeChatUIA, MAIN_CLASSES
    except Exception:                            # noqa: BLE001
        log.error("wechatauto 导入失败：%s", traceback.format_exc())
        return 5
    log.info("库里认的顶层类名 MAIN_CLASSES = %s", MAIN_CLASSES)

    uia = None
    win = None
    try:
        uia = WeChatUIA()
        t0 = time.time()
        ok = uia.ensure_window()
        log.info("ensure_window() = %s（%.1fs）", ok, time.time() - t0)
        hwnds = uia._wechat_hwnds()
        log.info("_wechat_hwnds() = %s", hwnds)
        win = getattr(uia, "_win", None)
        if ok and win is not None:
            log.info("主窗：UIA类名=%r 名称=%r AutomationId=%r",
                     getattr(win, "ClassName", None), getattr(win, "Name", None),
                     getattr(win, "AutomationId", None))
        else:
            fail("UIA 仍然认不出微信主窗：ensure_window() 返回 False。"
                 "把这份日志发出来，上面第 1、2 节就有线索。")
    except Exception:                            # noqa: BLE001
        log.error("ensure_window 抛异常：%s", traceback.format_exc())
        fail("UIA 初始化抛异常（见上面的栈）")

    # --------------------------------------------- 3.5 会话列表能不能读出来
    if uia is not None and win is not None:
        section("3.5 会话列表诊断（能不能按名字直接点开会话）")
        try:
            lst = uia._session_list()
            log.info("session_list 控件 = %r",
                     getattr(lst, "ClassName", None) if lst is not None else None)
            rows = uia._session_rows()
            log.info("会话列表行数 = %d", len(rows))
            for nm, _c in rows[:10]:
                log.info("  行：%r", nm)
        except Exception:                        # noqa: BLE001
            log.error("会话列表诊断异常：%s", traceback.format_exc())

    # ------------------------------------------------------- 4. 树 + 锚点
    if uia is not None and win is not None:
        section("4. 控件树导出与锚点检查")
        tree_lines = []
        try:
            def walk(el, depth, budget, out):
                if budget[0] <= 0 or depth > 7:
                    return
                try:
                    kids = el.GetChildren()
                except Exception as e:           # noqa: BLE001
                    out.append("%s! GetChildren: %r" % ("  " * depth, e))
                    return
                for k in kids:
                    budget[0] -= 1
                    if budget[0] <= 0:
                        return
                    try:
                        out.append("%s%s cls=%r aid=%r name=%r" % (
                            "  " * depth, k.ControlTypeName,
                            (k.ClassName or "")[:44], (k.AutomationId or "")[:44],
                            (k.Name or "")[:44]))
                    except Exception as e:       # noqa: BLE001
                        out.append("%s! read: %r" % ("  " * depth, e))
                        continue
                    walk(k, depth + 1, budget, out)

            walk(win, 1, [600], tree_lines)
        except Exception:                        # noqa: BLE001
            log.warning("遍历树失败：%s", traceback.format_exc())
        try:
            with open(TREE_PATH, "w", encoding="utf-8") as f:
                f.write("\n".join(tree_lines))
        except Exception:                        # noqa: BLE001
            log.warning("写 %s 失败：%s", TREE_PATH, traceback.format_exc())
        log.info("控件树 %d 个节点，已写入 %s", len(tree_lines), TREE_PATH)
        for line in tree_lines[:60]:
            log.info("  %s", line)
        if len(tree_lines) > 60:
            log.info("  …（后面还有 %d 行，在 %s）", len(tree_lines) - 60, TREE_PATH)

        try:
            rep = uia.describe_layout()
            log.info("布局报告：layout=%s main_class=%r title=%r",
                     rep.get("layout"), rep.get("main_class"), rep.get("title"))
            for k, v in (rep.get("anchors") or {}).items():
                log.info("    锚点 %-12s = %s", k, v)
            if not rep.get("anchors", {}).get("chat_input"):
                # 没打开任何会话时输入框本来就不在树里（这一节跑在「打开会话」之前），
                # 只提示，不算失败——真正的判据是第 5 节能不能发出去。
                log.info("提示：当前没有打开会话，所以 chat_input 还不在树里（正常）。"
                         "等第 5 节打开会话后会再找一次。")
        except Exception:                        # noqa: BLE001
            log.warning("describe_layout() 失败：%s", traceback.format_exc())

    # ---------------------------------------------------------------- 5. 发送
    section("5. 用 UIA 给「文件传输助手」发一条测试消息")
    target = "文件传输助手"
    text = "鲸鲸自检 %s" % time.strftime("%H:%M:%S")
    sent = False
    state = {"opened": None, "sent": None}

    def _worker():
        try:
            t0 = time.time()
            state["opened"] = bool(uia.open_chat(target))
            log.info("open_chat(%r) = %s（%.1fs）", target, state["opened"],
                     time.time() - t0)
            if state["opened"]:
                t0 = time.time()
                state["sent"] = bool(uia.send_text(text))
                log.info("send_text() = %s（%.1fs）内容=%r", state["sent"],
                         time.time() - t0, text)
        except Exception:                        # noqa: BLE001
            log.error("发送抛异常：%s", traceback.format_exc())
            fail("UIA 发送抛异常（见上面的栈）")

    if uia is not None and win is not None:
        th = threading.Thread(target=_worker, name="selftest-send", daemon=True)
        th.start()
        th.join(SEND_TIMEOUT)
        if th.is_alive():
            STUCK.append(th)
            try:
                import uia_compat
                step, cost = uia_compat.current_step()
            except Exception:                    # noqa: BLE001
                step, cost = (None, 0.0)
            fail("发送卡住 %d 秒没返回，停在步骤 %r（已 %.1fs）。这说明 UIA 的某个"
                 "调用在这里等死了，不是发得慢。" % (SEND_TIMEOUT, step, cost))
        sent = bool(state.get("sent"))
        if state.get("opened") is False and not th.is_alive():
            fail("打不开「文件传输助手」会话：UIA 的 open_chat 失败。")
        if state.get("opened") and sent is False and not th.is_alive() \
                and not any("卡住" in str(p) for p in PROBLEMS):
            fail("send_text() 返回 False：消息没发出去。")
    else:
        log.info("跳过：上一步没认到主窗。")

    # ---------------------------------------------------------- 5.5 群聊
    section("5.5 群聊能不能打开（只切会话，不发消息）")
    try:
        from wechatauto import WeChatDB

        _db = WeChatDB()
        rooms = [s.get("username") for s in _db.get_sessions(limit=80)
                 if (s.get("username") or "").endswith("@chatroom")]
        if not rooms or uia is None:
            log.info("没有群会话 / 还没认到主窗，跳过。")
        else:
            room = rooms[0]
            aliases = []
            _nm = _db.group_id_to_name(room) or ""
            if _nm and _nm != room:
                aliases.append(_nm)
            _nicks = []
            for _m in (_db.get_group_members(room) or []):
                if _m.get("username") == _db.wxid:
                    continue
                _n = (_m.get("remark") or "").strip() or (_m.get("nick_name") or "").strip()
                if _n:
                    _nicks.append(_n)
            if _nicks:
                aliases.append("、".join(_nicks))
            aliases = aliases or [room]
            log.info("群 %s 的候选名：%s", room, " / ".join(aliases))
            _t0 = time.time()
            ok_room = False
            try:
                ok_room = bool(uia.open_chat(aliases))
            except Exception:                    # noqa: BLE001
                log.error("打开群聊抛异常：%s", traceback.format_exc())
            cur_room = None
            try:
                cur_room = uia.current_chat()
            except Exception:                    # noqa: BLE001
                pass
            log.info("打开群聊 = %s（%.1fs）current_chat=%r", ok_room,
                     time.time() - _t0, cur_room)
            if ok_room:
                log.info("✓ 群聊能按「成员名」认出来，桥接发群消息应该也通了。")
            else:
                warn("群聊打不开：把上面几行日志发给我（里面有会话列表的候选名）。")
    except Exception:                            # noqa: BLE001
        log.warning("群聊检查跳过：%s", traceback.format_exc())

    # ---------------------------------------------------------------- 6. 验证
    section("6. 回读数据库确认消息真的发出去了")
    if sent:
        try:
            from wechatauto import WeChatDB
            db = WeChatDB()
            msgs = db.get_messages("filehelper", limit=5)
            contents = [(m.get("content") or "").strip() for m in msgs]
            for i, c in enumerate(contents):
                log.info("  最近消息[%d] = %r", i, c[:60])
            if any(text in c for c in contents):
                log.info("✓ 数据库里能找到刚发的这条，发送通道真的通了。")
            else:
                warn("send_text 说成功了，但数据库里没读到那条消息——"
                     "可能只是把字打进了输入框、没按到发送。")
        except Exception:                        # noqa: BLE001
            log.warning("回读数据库失败（不影响结论，可能是密钥/路径问题）：%s",
                        traceback.format_exc())

    # ---------------------------------------------------------------- 结论
    section("结论")
    if not PROBLEMS:
        log.info("✓✓ 全通：UIA 能认主窗、能发消息，数据库也能证实。")
        log.info("   接下来直接双击「启动微信桥接.bat」用就行。")
        return 0
    log.error("还有 %d 个问题：", len(PROBLEMS))
    for p in PROBLEMS:
        log.error("  · %s", p)
    log.error("日志：%s", LOG_PATH)
    if os.path.exists(TREE_PATH):
        log.error("控件树：%s", TREE_PATH)
    return 1


if __name__ == "__main__":
    code = 1
    try:
        code = main()
    except Exception:                            # noqa: BLE001
        log.error("自检脚本自己崩了：%s", traceback.format_exc())
    finally:
        for h in log.handlers + _wx.handlers:
            try:
                h.flush()
            except Exception:                    # noqa: BLE001
                pass
        log.info("")
        log.info("退出码 %s，日志：%s", code, LOG_PATH)
        if STUCK:
            # 发送线程还卡在 UIA 里：正常退出会被它拖住，只能硬退（日志已 flush）。
            log.error("有 %d 个线程卡死在 UIA 调用里，强制退出。", len(STUCK))
            for h in log.handlers + _wx.handlers:
                try:
                    h.flush()
                except Exception:                # noqa: BLE001
                    pass
            os._exit(code)
        sys.exit(code)
