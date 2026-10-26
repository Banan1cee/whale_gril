"""
鲸鲸 · 一键暂停/恢复热键守护
- PageUp  (VK_PRIOR)：先给最近 3 个聊天发「我先歇一会儿…」，然后停掉服务 + 微信桥接
- PageDown(VK_NEXT) ：恢复服务和桥接

用法：
    python tools/hotkey_daemon.py            # 后台常驻
    python tools/hotkey_daemon.py --dry-run  # 只打印，不真的停/发
    python tools/hotkey_daemon.py --pause    # 手动执行一次暂停
    python tools/hotkey_daemon.py --resume   # 手动执行一次恢复
"""
import os
import sys
import time
import subprocess

import psutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
FLAG = os.path.join(DATA, "PAUSED")
LOG_FILE = os.path.join(DATA, "hotkey.log")
FAREWELL = "我先歇一会儿，然后我就要开始打游戏了"
DRY_RUN = "--dry-run" in sys.argv


def log(*parts):
    line = "[%s] %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), " ".join(str(p) for p in parts))
    print(line, flush=True)
    try:
        os.makedirs(DATA, exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def _cmdline(proc):
    try:
        return " ".join(proc.info.get("cmdline") or proc.cmdline() or [])
    except Exception:
        return ""


def stop_bot():
    """杀掉桥接 python 和 8787 端口的服务进程"""
    killed = []
    for proc in psutil.process_iter(["pid", "name", "cmdline"]):
        cl = _cmdline(proc)
        if "wechatauto_bridge.py" in cl:
            try:
                log("结束桥接进程", proc.info["pid"])
                if not DRY_RUN:
                    proc.kill()
                killed.append(proc.info["pid"])
            except Exception as e:
                log("结束桥接失败", e)

    # 方式二：按命令行找 server.js（net_connections 有时权限不足）
    me = os.getpid()
    for proc in psutil.process_iter(["pid", "cmdline"]):
        if proc.info["pid"] == me:
            continue
        cl = _cmdline(proc)
        if "server.js" in cl and "whale-girl" in cl.replace("\\\\", "/"):
            try:
                log("结束服务进程(命令行)", proc.info["pid"])
                if not DRY_RUN:
                    proc.kill()
                killed.append(proc.info["pid"])
            except Exception as e:
                log("结束服务失败", e)

    try:
        for conn in psutil.net_connections(kind="inet"):
            if conn.laddr and conn.laddr.port == 8787 and conn.status == "LISTENING" and conn.pid:
                try:
                    log("结束服务进程", conn.pid)
                    if not DRY_RUN:
                        psutil.Process(conn.pid).kill()
                    killed.append(conn.pid)
                except Exception as e:
                    log("结束服务失败", e)
    except Exception as e:
        log("查端口失败", e)
    return killed


def _display_name(db, username):
    try:
        if username.endswith("@chatroom"):
            for s in db.get_sessions(50):
                if s.get("username") == username and s.get("summary"):
                    return s.get("summary") or username
        nick = db.get_nickname(username)
        if nick:
            return nick
    except Exception:
        pass
    return username


def send_farewell(limit=3):
    """给最近聊天的人发「我先歇一会儿…」；返回发给了谁"""
    try:
        from wechatauto import WeChatGUI, WeChatDB
    except Exception as e:
        log("导入 wechatauto 失败", e)
        return []

    sent = []
    if os.environ.get("HOTKEY_SKIP_SEND") == "1":
        log("跳过发送（HOTKEY_SKIP_SEND=1）")
        return sent
    try:
        db = WeChatDB()
        gui = WeChatGUI()
        sessions = [s for s in db.get_sessions(20) if s.get("username")]
        targets = []
        for s in sessions:
            u = s["username"]
            if u in ("filehelper", "weixin", "medianote"):
                continue
            targets.append((u, _display_name(db, u)))
            if len(targets) >= limit:
                break
        for username, name in targets:
            try:
                log("发暂停通知 →", name)
                if not DRY_RUN:
                    gui.send_msg(FAREWELL, name, verify=False)
                sent.append(name)
            except Exception as e:
                log("发暂停通知失败", name, repr(e))
    except Exception as e:
        log("发暂停通知异常", repr(e))
    return sent


def test_send():
    """只给文件传输助手发一条，验证发送通道"""
    from wechatauto import WeChatGUI
    gui = WeChatGUI()
    r = gui.send_msg(FAREWELL, "文件传输助手", verify=True)
    log("测试发送:", r)


def pause_bot():
    log("=== PageUp：终止鲸鲸 ===")
    os.makedirs(DATA, exist_ok=True)
    if not DRY_RUN:
        with open(FLAG, "w", encoding="utf-8") as f:
            f.write(str(time.time()))
    stop_bot()
    log("已终止（按 PageDown 继续）")
    log("已终止（按 PageDown 继续）")
