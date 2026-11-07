# -*- coding: utf-8 -*-
"""桥接日志：文件全量、控制台按级别过滤。

原来这些函数混在 engine.py 里，和启动流程、配置解析互相看见。拆出来后：

- 只依赖 `configure()` 传进来的日志路径和级别；
- `log_throttled` 仍留在 engine（它要读调用方的节流表），这里只提供最底层的
  `log` / `log_warn` / `log_error` / `boot` / `log_window_problem`；
- warn/error 继续带「文件:行」调用点，拆模块后也不会丢。
"""

import os
import sys
import time

LOG_FILE = ""
BOOT_LOG = ""
LOG_LEVEL = "info"

# 老的 log() 没有级别，只能按关键词猜「这句算不算报错」；显式级别优先。
_LOG_ERROR_HINT = ("错误", "失败", "异常", "超时", "Traceback", "Exception", "Error", "error:", "?")
_LOG_DEBUG_HINT = ("调试", "详细", "等级=", "窗口", "查询", "缓存", "装载", "收到")

_LOGGER_CODES = set()
_last_rotate_check = [0.0]
_win_problem_ts = {}


def configure(log_file=None, boot_log=None, level=None):
    """启动时注入路径和级别；之后再改只用 set_level / set_file。"""
    global LOG_FILE, BOOT_LOG
    if log_file:
        LOG_FILE = log_file
    if boot_log:
        BOOT_LOG = boot_log
    set_level(level)


def set_level(level):
    global LOG_LEVEL
    value = str(level or "").strip().lower()
    LOG_LEVEL = value if value in ("debug", "info", "error") else "info"


def set_file(path):
    global LOG_FILE
    LOG_FILE = str(path or "")


def boot(msg):
    """启动诊断：只写文件，不依赖控制台（控制台被选中时 print 会卡住）。"""
    if not BOOT_LOG:
        return
    try:
        os.makedirs(os.path.dirname(BOOT_LOG), exist_ok=True)
        with open(BOOT_LOG, "a", encoding="utf-8") as f:
            f.write("%s [pid %s] %s\n" % (time.strftime("%H:%M:%S"), os.getpid(), msg))
    except Exception:
        pass


def _log_allowed(level, text):
    """控制台过滤：显式级别优先；老的 log() 命中报错词时抬成 warn，保持可读性。"""
    if LOG_LEVEL == "debug":
        return True
    hinted = level == "info" and any(h in text for h in _LOG_ERROR_HINT)
    if LOG_LEVEL == "error":
        return level == "error" or hinted
    if level in ("warn", "error") or hinted:
        return True
    return not any(h in text for h in _LOG_DEBUG_HINT)


def _caller_where():
    """warn/error 用：调用点「文件:行」，跳过 logger 自己的包装帧。"""
    try:
        frame = sys._getframe(1)
        while frame is not None and frame.f_code in _LOGGER_CODES:
            frame = frame.f_back
        if frame is None:
            return ""
        name = os.path.basename(frame.f_code.co_filename)
        if name.endswith(".py"):
            name = name[:-3]
        return "%s:%d" % (name, frame.f_lineno)
    except Exception:                                  # noqa: BLE001
        return ""


def _fmt_log_arg(a):
    """日志参数不省略：异常展开完整 traceback，容器用 repr，字符串原样。"""
    if isinstance(a, BaseException):
        import traceback
        return "".join(traceback.format_exception(type(a), a, a.__traceback__)).strip()
    if isinstance(a, (dict, list, tuple, set)):
        return repr(a)
    return str(a)


def _rotate_bridge_log():
    """日志文件超过 10MB 就轮转成 .1（只留一份）。"""
    import time as _t
    now = _t.time()
    if now - _last_rotate_check[0] < 60:
        return
    _last_rotate_check[0] = now
    if not LOG_FILE:
        return
    try:
        if os.path.getsize(LOG_FILE) <= 10 * 1024 * 1024:
            return
        bak = LOG_FILE + ".1"
        if os.path.exists(bak):
            os.remove(bak)
        os.replace(LOG_FILE, bak)
    except Exception:
        pass


def _emit_log(level, args, where=""):
    text = " ".join(_fmt_log_arg(a) for a in args)
    head = time.strftime("[%H:%M:%S] ") + level.upper()
    line = head + " " + (("[" + where + "] ") if where else "") + text
    # 文件：永远记全量；界面/启动器控制台按 LOG_LEVEL 过滤。
    if LOG_FILE:
        try:
            os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
            _rotate_bridge_log()
            with open(LOG_FILE, "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except Exception:                              # noqa: BLE001
            pass
    if not _log_allowed(level, text):
        return
    try:
        print(line, flush=True)
    except Exception:                                  # noqa: BLE001
        pass


def log(*args):
    """老调用：info 级。"""
    _emit_log("info", args)


def log_debug(*args):
    _emit_log("debug", args)


def log_warn(*args):
    """已降级/已自愈，但值得记一笔（切通道、跳过一次、重试成功）。"""
    _emit_log("warn", args, _caller_where())


def log_error(*args):
    """这次功能真的坏了（发送彻底失败、写盘失败、配置读不出来）。"""
    _emit_log("error", args, _caller_where())


def log_window_problem(where, err):
    """窗口操作失败两分钟内只报一次。

    挪不动/置顶不了窗口不该让整条发送失败（UIA 还能把字打进去），
    更不该让看门狗以为“发送卡住”把桥接反复重启——那会一直弹「拒绝访问」。
    """
    now = time.time()
    if now - _win_problem_ts.get(where, 0) < 120:
        return
    _win_problem_ts[where] = now
    log_warn(where + "：", repr(err))


for _fn in (log, log_debug, log_warn, log_error, _emit_log):
    _LOGGER_CODES.add(_fn.__code__)
del _fn
