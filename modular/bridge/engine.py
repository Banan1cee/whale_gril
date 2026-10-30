#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
鲸鲸 · 微信 4.x 桥接（不注入、不修改微信）

原理：
  - 读消息：解密微信 4.x 本地 SQLite 数据库（只读，需要微信处于登录状态）
  - 发消息：驱动微信窗口（UI 自动化 + 剪贴板），相当于有人替你打字发送

前置：
  1. WeChat 4.x 已登录（建议用小号）
  2. 已装依赖：pip install wechatauto-replica requests
  3. 鲸鲸服务已启动（双击 启动鲸鱼娘.bat）
  4. config.json 里 gateway.wechat.enabled = true（脚本会读 token）

用法：
  python examples/wechatauto_bridge.py

发送通道（按优先级，前一条失败才试下一条）：
  0. 零焦点通道  PostMessage 伪焦点 + GBK 字节 WM_CHAR + 点发送按钮
                 （bridge/bg_sender.py，见 docs/微信消息后台发送.md，不抢前台）
  1. UIA 通道    wechatauto 驱动控件树（默认打 quiet 补丁，但仍可能抢前台）
  2. 键盘通道    Ctrl+F 搜会话 → 剪贴板粘贴 → 回车（一定抢前台）
  3. OCR 通道    截图找发送按钮（最后兜底，可能卡在截屏）

注意：
  - 微信必须保持登录；退出登录后数据库密钥会失效。
  - 自动化不是微信官方接口，仍有账号风险，只用小号 + 测试群。
  - 零焦点通道要求：微信窗口**未最小化**、两边权限一致（都普通或都管理员）、
    中文系统（代码页 936）。任一不满足会自动退回下面的通道。
"""

import json
import random
import re
import urllib.parse
import os
# 关掉 wechatauto 的「拟人节流」（默认 natural：120 秒内 6 次写就冷却 30~75 秒）
os.environ.setdefault("WECHATAUTO_RHYTHM", "off")
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
import sys
import subprocess
import threading
import time

# Windows embeddable Python's ._pth omits the script directory; load only our
# shipped helper from this explicit directory, never from the current working directory.
_EXAMPLES_DIR = os.path.dirname(os.path.abspath(__file__))
if _EXAMPLES_DIR not in sys.path:
    sys.path.insert(0, _EXAMPLES_DIR)
from sticker_transport import (guarded_send as guarded_sticker_send, read_enabled_config,
                               resolve_target as resolve_sticker_target, result as sticker_result,
                               WindowsDesktop, quarantined_input_value,
                               account_evidence_allowed as sticker_account_evidence_ok,
                               alias_match as sticker_alias_match,
                               _is_blank as sticker_input_is_blank)

try:                                    # UIA 自检/物化：挑真窗口 + 真判据
    from bridge import uia_boot
except Exception:                       # noqa: BLE001
    try:
        import uia_boot
    except Exception:                   # noqa: BLE001
        uia_boot = None

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(ROOT, "config.json")
LOG_FILE = os.path.join(ROOT, "data", "wechat-bridge-4x.log")

# 只回复这些会话（留空 = 全部会话都交给鲸鲸判断）
# 例如 ["文件传输助手", "深海鱼塘"]
ONLY_CHATS = []

# 距离启动多久之前的消息不处理（秒）
SKIP_OLDER_THAN = 10
MASTER_WXID = ''
# 超过这么多秒的旧消息直接不回，避免“回上一条”
STALE_AFTER = float(os.environ.get("WHALE_STALE_AFTER", "4"))

# 主动搭话（care）的开关：先给默认值，下面读 config 时再覆盖。
# 保底：只要启动时配置解析失败，这些名字也必须存在，否则后台线程会 NameError 退出。
CARE_ENABLED = False
CARE_ALLOW_GROUPS = False
CARE_ONLY_MASTER = True
CARE_ALLOW_OTHERS = False
CARE_QUIET_MIN = 20.0
# Fail closed even when an earlier setting makes startup config parsing fail.
STICKER_TEST_ON = False


def _as_bool(value, default=False):
    """配置里的布尔：兼容写成字符串 "false" 的老配置。

    以前 bool("false") 是 True —— 于是 care.allowGroups 明明写着 "false"，
    桥接却当成「允许进群」。
    """
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    return str(value).strip().lower() in ("1", "true", "yes", "on", "开")


def _parse_bg_send(wechat_cfg):
    """解析 `wechat.bgSend`（零焦点发送通道）。

    默认全开：这是唯一不抢前台的通道，关掉就等于退回「发一条抢一次焦点」。
    """
    raw = (wechat_cfg or {}).get("bgSend")
    if not isinstance(raw, dict):
        raw = {}

    def _num(key, default, lo, hi):
        try:
            v = float(raw.get(key, default))
        except Exception:
            v = float(default)
        return min(hi, max(lo, v))

    return {
        "enabled": _as_bool(raw.get("enabled", True), True),
        # 文档 §4.7：字节间隔 ≤45ms，太短会丢字；给个 20~80 的安全区间
        "charGap": _num("charGapMs", 40, 20, 80) / 1000.0,
        # 发完回读输入框是否清空；关掉能省 ~0.5s，但少了「真发出去」的证据
        "verify": _as_bool(raw.get("verify", True), True),
        # 后台通道失败时要不要退回会抢前台的旧通道
        "fallback": _as_bool(raw.get("fallbackToForeground", True), True),
        # GBK 编不了的字符（emoji 等）是跳过还是整条退回旧通道
        "strip": _as_bool(raw.get("stripUnencodable", True), True),
        # 微信缩在托盘里（窗口隐藏）时，用「显示但不激活」把它拉出来 —— 不抢前台
        "unhide": _as_bool(raw.get("unhideWindow", True), True),
        # WM_CHAR 的编码语义：auto = 按微信版本自动（4.2+ 用 UTF-16 码元）
        "charMode": str(raw.get("charMode") or "auto").lower(),
    }


# 零焦点发送通道的默认值：config 读失败时也能工作（这个通道失败会自动退回旧通道，
# 所以默认开着是安全的）。
BG_SEND = {"enabled": True, "charGap": 0.04, "verify": True, "charMode": "auto",
           "fallback": True, "strip": True, "unhide": True}

# 消息调度：同一个会话串行、跨会话并发。workers=1 就等于旧行为（全部串行）。
PIPELINE_WORKERS = 4
PIPELINE_QUEUE_LIMIT = 4

_cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "config.json")
# 新版发行包不再自带 config.json（免得覆盖安装时把用户的主人名单/token 冲掉）。
# 如果用户先双击了桥接、服务还没起过，这里用 example 生成一份，避免「token 空 → 401 → 她不回话」。
if not os.path.exists(_cfg_path):
    _example = os.path.join(os.path.dirname(_cfg_path), "config.example.json")
    if os.path.exists(_example):
        try:
            import shutil
            shutil.copyfile(_example, _cfg_path)
            log_call = True
        except Exception:
            pass
try:
    with open(_cfg_path, "r", encoding="utf-8-sig") as _f:
        _cfg = json.load(_f)
    _stale = (_cfg.get("wechat") or {}).get("staleAfterSec")
    if isinstance(_stale, (int, float)) and _stale > 0:
        STALE_AFTER = float(_stale)
    _wechat = _cfg.get("wechat") or {}
    GAME_TOKENS = [str(x).lower() for x in (_wechat.get("gameWhitelist") or []) if str(x).strip()]
    AWAY_NOTICE = bool(_wechat.get("awayNotice", True))
    RETURN_NOTICE = bool(_wechat.get("returnNotice", True))
    QUEUED_MAX_AGE = float(_wechat.get("queuedMaxAgeSec", 300))
    QUEUED_MAX_CHATS = int(_wechat.get("queuedMaxChats", 2))
    # 引用回复要额外走一遍「悬停消息 → 点回复 → 输入」，实测一条能慢好几秒；默认关
    QUOTE_REPLY = bool(_wechat.get("quoteReply", False))
    # UIA 彻底发不出去时，退到「Ctrl+F 搜索会话 → 粘贴 → 回车」的键盘通道（会抢前台）
    KEYBOARD_FALLBACK = bool(_wechat.get("keyboardFallback", True))
    # 后台发送：不抢前台直接发（实测最小化/被遮挡也能发）。false = 每次先把微信拉到前台
    BACKGROUND_SEND = bool(_wechat.get("backgroundSend", True))
    # 零焦点通道（bridge/bg_sender.py）：真正不碰前台的发送方式。
    # 和上面那个 backgroundSend 的区别：backgroundSend 是「尽量少占前台，失败就拉前台」，
    # bgSend 是「结构上不碰前台，做不到就退回旧通道」。
    try:
        BG_SEND = _parse_bg_send(_wechat)
    except Exception:
        pass
    try:
        PIPELINE_WORKERS = max(1, min(16, int(_wechat.get("pipelineWorkers", 4) or 4)))
        PIPELINE_QUEUE_LIMIT = max(1, min(32, int(_wechat.get("pipelineQueueLimit", 4) or 4)))
    except Exception:
        pass
    # 调试用：WHALE_PIPELINE_WORKERS=1 可以立刻退回「全串行」的旧行为
    try:
        _pw = os.environ.get("WHALE_PIPELINE_WORKERS")
        if _pw:
            PIPELINE_WORKERS = max(1, min(16, int(_pw)))
    except Exception:
        pass
    # 多账号（同时登着大号 + 小号）：启动时钉死在 wechat.account 指定的那个号上，
    # 发送前再确认「要发消息的那个窗口就是这个号」；认不出来宁可不发，也不从别的号发。
    # accountGuard=false 只用于「本机确实只登一个号、但窗口读取时好时坏」的兜底。
    ACCOUNT_GUARD = bool(_wechat.get("accountGuard", True))
    # 手动钉窗口（调试用）：填微信主窗的 hwnd，直接用它，跳过自动识别
    WINDOW_HWND = int(_wechat.get("windowHwnd") or 0)
    # 网页「设置」里选的账号（目录名 / wxid / 昵称都行）；留空 = 自动选「最近活跃」
    ACCOUNT_WANTED = str(_wechat.get("account") or "").strip()
    LOW_BATTERY_PCT = float(_wechat.get("lowBatteryPercent", 5))
    GOODNIGHT_TEXT = str(_wechat.get("goodnightText", "晚安，电量快没了，我先睡啦，明天见～"))
    _share = _cfg.get("share") or {}
    SHARE_ENABLED = bool(_share.get("enabled", True))
    SHARE_EVERY = float(_share.get("everyMinutes", 120))
    # 主动搭话（问「在干啥 / 累不累」）。时间窗和频率由服务端 /api/care/due 算，这里只留一个开关和静默期
    _care = _cfg.get("care") or {}
    # 主动搭话默认关（群里突然打招呼很社死）；就算开了也只私聊，除非显式 allowGroups
    CARE_ENABLED = bool(_care.get("enabled", False))
    CARE_ALLOW_GROUPS = _as_bool(_care.get("allowGroups", False), False)
    CARE_ONLY_MASTER = _as_bool(_care.get("onlyMaster", True), True)
    CARE_ALLOW_OTHERS = _as_bool(_care.get("allowOthers", False), False)
    CARE_QUIET_MIN = float(_care.get("quietAfterMinutes", 20) or 0)
    # 表情包（实验性）：总闸在 features.stickers。关着就不轮询、不发图、日志一句不提。
    STICKER_TEST_ON = _as_bool(((_cfg.get("features") or {}).get("stickers", False)), False)
    MASTER_WXID = (((_cfg.get("persona") or {}).get("master") or {}).get("wxids") or [''])[0]
except Exception:
    pass

START_TS = time.time()


# 同一类错误 10 分钟只记一行：没配看图 Key 时，每张图刷一条日志会淹掉真正的问题
# 本机请求专用：不读系统代理。用户装了 Clash 之类的代理但没开时，
# HTTP_PROXY 会让连 127.0.0.1 的请求也走代理 → 报「由于目标计算机积极拒绝」。
import requests as _requests  # 延迟到这里再 import，避免顶部依赖顺序问题


class _ThreadLocalHTTP:
    """每个线程一个 `requests.Session`。

    `requests.Session` 不是线程安全的，而 3.57 起消息是**跨会话并发**处理的
    （`MessagePipeline`）。共用一个 Session 会出现连接池 / header 串台。
    接口和 Session 一样（get / post / close），调用方不用改。
    """

    trust_env = False

    def __init__(self):
        self._local = threading.local()
        self._all = []
        self._guard = threading.Lock()

    def _session(self):
        s = getattr(self._local, "session", None)
        if s is None:
            s = _requests.Session()
            s.trust_env = False          # 本机请求不读系统代理（Clash 没开时会积极拒绝）
            self._local.session = s
            with self._guard:
                self._all.append(s)
        return s

    def get(self, *args, **kwargs):
        return self._session().get(*args, **kwargs)

    def post(self, *args, **kwargs):
        return self._session().post(*args, **kwargs)

    def close(self):
        with self._guard:
            for s in self._all:
                try:
                    s.close()
                except Exception:
                    pass
            self._all.clear()


LOCAL_HTTP = _ThreadLocalHTTP()
os.environ["NO_PROXY"] = ",".join(filter(None, [os.environ.get("NO_PROXY", ""), "127.0.0.1,localhost,::1"]))
_THROTTLE_LOG = {}
# 和服务端的连接状态：用来只在「断开→恢复」时各打一次日志
CONN_STATE = {"ok": None}


def log_throttled(key, *args, ttl=600):
    now = time.time()
    last = _THROTTLE_LOG.get(key) or 0
    if now - last < ttl:
        _THROTTLE_LOG["__skip_" + key] = _THROTTLE_LOG.get("__skip_" + key, 0) + 1
        return
    skipped = _THROTTLE_LOG.pop("__skip_" + key, 0)
    if skipped:
        log(f"（上面这类日志还有 {skipped} 条被折叠了）")
    _THROTTLE_LOG[key] = now
    log(*args)



def reload_config(path=None):
    """把 config.json 重新读一遍，覆盖上面这些「启动时定型」的开关。

    为什么需要：调试台（/debug）改的是 config.json，但桥接以前只在启动时读一次，
    用户在页面上关掉「主动分享」、改「忽略名单」、调「游戏白名单」……全都没反应，
    只能手动重启「启动微信桥接.bat」，表现出来就是「调了没用，还是默认」。
    现在 config.json 一变，5 秒内自动生效。

    返回是否真的重新加载了。
    """
    global GAME_TOKENS, AWAY_NOTICE, RETURN_NOTICE, QUEUED_MAX_AGE, QUEUED_MAX_CHATS
    global QUOTE_REPLY, KEYBOARD_FALLBACK, BACKGROUND_SEND, LOW_BATTERY_PCT, GOODNIGHT_TEXT
    global BG_SEND, PIPELINE_WORKERS, PIPELINE_QUEUE_LIMIT
    global ACCOUNT_GUARD, WINDOW_HWND, STICKER_TEST_ON
    global SHARE_ENABLED, SHARE_EVERY, CARE_ENABLED, CARE_QUIET_MIN
    global STALE_AFTER, SYSTEM_SENDER_NAMES, BASE_SYSTEM_SENDERS, MASTER_WXID
    global VOICE_ENABLED, VOICE_BASE_URL, VOICE_MODEL, VOICE_API_KEY, VOICE_TIMEOUT, VOICE_MAX_SECONDS
    target = path or CONFIG_PATH
    try:
        with open(target, "r", encoding="utf-8-sig") as f:
            cfg = json.load(f)
    except Exception as e:                      # noqa: BLE001
        log("重读配置失败（继续用旧值）：", repr(e))
        return False

    w = cfg.get("wechat") or {}
    try:
        STALE_AFTER = float(w.get("staleAfterSec") or STALE_AFTER or 4)
    except Exception:
        pass
    GAME_TOKENS = [str(x).lower() for x in (w.get("gameWhitelist") or []) if str(x).strip()]
    AWAY_NOTICE = bool(w.get("awayNotice", True))
    RETURN_NOTICE = bool(w.get("returnNotice", True))
    try:
        QUEUED_MAX_AGE = float(w.get("queuedMaxAgeSec", 300))
        QUEUED_MAX_CHATS = int(w.get("queuedMaxChats", 2))
        LOW_BATTERY_PCT = float(w.get("lowBatteryPercent", 5))
    except Exception:
        pass
    QUOTE_REPLY = bool(w.get("quoteReply", False))
    KEYBOARD_FALLBACK = bool(w.get("keyboardFallback", True))
    BACKGROUND_SEND = bool(w.get("backgroundSend", True))
    try:
        BG_SEND = _parse_bg_send(w)
    except Exception:
        pass
    try:
        PIPELINE_WORKERS = max(1, min(16, int(w.get("pipelineWorkers", PIPELINE_WORKERS) or 4)))
        PIPELINE_QUEUE_LIMIT = max(1, min(32, int(w.get("pipelineQueueLimit", PIPELINE_QUEUE_LIMIT) or 4)))
    except Exception:
        pass
    ACCOUNT_GUARD = bool(w.get("accountGuard", True))
    try:
        WINDOW_HWND = int(w.get("windowHwnd") or 0)
    except Exception:
        WINDOW_HWND = 0
    # 账号是在建库时钉死的，改不了；这里只负责「发现网页改了账号 → 让桥接自己重启」。
    wanted_now = str(w.get("account") or "").strip()
    if wanted_now != ACCOUNT_WANTED:
        log("账号设置变了（%r → %r），3 秒后自动重启桥接…" % (ACCOUNT_WANTED, wanted_now))
        time.sleep(3)
        # bridge_loop.bat 把 exit code 7 当成「桥接自己要求重启」，3 秒后会用新配置拉起来。
        # 直接 os._exit 而不是 sys.exit：这里是后台线程，sys.exit 退不掉整个进程。
        os._exit(7)
    GOODNIGHT_TEXT = str(w.get("goodnightText") or GOODNIGHT_TEXT)
    # 忽略名单：系统会话是固定底表，配置里的只追加
    SYSTEM_SENDER_NAMES = set(BASE_SYSTEM_SENDERS)
    SYSTEM_SENDER_NAMES |= {str(x).strip() for x in (w.get("ignoreSenders") or []) if str(x).strip()}

    sh = cfg.get("share") or {}
    SHARE_ENABLED = bool(sh.get("enabled", True))
    try:
        SHARE_EVERY = float(sh.get("everyMinutes", 120))
    except Exception:
        SHARE_EVERY = 120.0

    ca = cfg.get("care") or {}
    global CARE_ENABLED, CARE_ALLOW_GROUPS, CARE_ONLY_MASTER, CARE_ALLOW_OTHERS
    CARE_ENABLED = _as_bool(ca.get("enabled", True), True)
    CARE_ALLOW_GROUPS = _as_bool(ca.get("allowGroups", False), False)
    CARE_ONLY_MASTER = _as_bool(ca.get("onlyMaster", True), True)
    CARE_ALLOW_OTHERS = _as_bool(ca.get("allowOthers", False), False)
    try:
        CARE_QUIET_MIN = float(ca.get("quietAfterMinutes", 20) or 0)
    except Exception:
        CARE_QUIET_MIN = 20.0

    vo = cfg.get("voice") or {}
    if "enabled" in vo:
        VOICE_ENABLED = bool(vo.get("enabled"))
    if vo.get("baseUrl"):
        VOICE_BASE_URL = str(vo.get("baseUrl"))
    if vo.get("model"):
        VOICE_MODEL = str(vo.get("model"))
    # 语音这几项以前只在启动时读一次：网页里换了 Key / 调了超时，必须重启才生效
    try:
        if vo.get("timeoutMs") is not None:
            VOICE_TIMEOUT = float(vo.get("timeoutMs")) / 1000.0
        if vo.get("maxSeconds") is not None:
            VOICE_MAX_SECONDS = float(vo.get("maxSeconds"))
    except Exception:
        pass
    VOICE_API_KEY = _resolve_voice_key(cfg)

    wxids = (((cfg.get("persona") or {}).get("master") or {}).get("wxids") or [])
    if wxids:
        MASTER_WXID = wxids[0]
    return True


# 系统 / 公众号通知：只用来记录，不接话（否则会跟「微信团队」吵起来）
SYSTEM_SENDER_NAMES = {
    "微信团队", "微信支付", "服务通知", "订阅号消息", "文件传输助手",
    "微信运动", "微信公众平台", "腾讯客服", "微信安全中心", "微信广告",
}
try:
    SYSTEM_SENDER_NAMES |= {str(x).strip() for x in (_wechat.get("ignoreSenders") or []) if str(x).strip()}
except Exception:
    pass
# 系统会话名单的原始底表（热更新时以它为基准重新算，避免配置里的旧值越滚越多）
BASE_SYSTEM_SENDERS = set(SYSTEM_SENDER_NAMES)

# 微信 4.x 数据目录的常见名字（不同版本 / 不同安装方式会有差异）
DB_ROOT_NAMES = ("xwechat_files", "WeChat Files", "xwechat_files_data")


def looks_like_db_root(p):
    """这个目录像不像微信 4.x 的数据根（下面有 <账号>/db_storage）。

    兼容四种布局（以前只认第一种，文档写了后面几种却没实现）：
      E:\\xwechat_files\\<账号>\\db_storage
      E:\\xwechat_files\\db_storage            （账号目录层级被拍平）
      直接把 <账号> 目录填进来（p\\db_storage）
      直接把 db_storage 目录填进来
    """
    if not p or not os.path.isdir(p):
        return False
    # 直填账号目录 / 直填 db_storage
    if os.path.isdir(os.path.join(p, "db_storage")):
        return True
    if os.path.basename(os.path.normpath(p)).lower() == "db_storage":
        return True
    bases = [p]
    for name in DB_ROOT_NAMES:
        bases.append(os.path.join(p, name))
    for base in bases:
        try:
            entries = os.listdir(base)
        except OSError:
            continue
        for name in entries:
            if os.path.isdir(os.path.join(base, name, "db_storage")):
                return True
    return False


def iter_drive_roots():
    """列出真实的磁盘根（含 L:、网络映射盘、UNC），不再写死 C..K。"""
    roots = []
    try:
        import string
        for letter in string.ascii_uppercase:
            root = letter + ":\\"
            if os.path.isdir(root):
                roots.append(root)
    except Exception:
        pass
    try:
        import psutil
        for part in psutil.disk_partitions(all=False):
            mp = str(part.mountpoint or "")
            if mp and mp not in roots and os.path.isdir(mp):
                roots.append(mp)
    except Exception:
        pass
    return roots


def resolve_db_dir(config_path=None, drives="CDEFGHIJK"):
    """找微信 4.x 的数据库目录，比 wechatauto 自带的 auto_detect 更狠。

    库自带的只查「文档 / 用户目录 / 注册表」，用户把微信文件存到别的盘
    （很常见：E:\\xwechat_files、D:\\xwechat_files）就永远找不到，启动直接
    RuntimeError 崩掉 —— 也就是用户截图里那一整段 Traceback。

    顺序：config.json 的 wechat.dbDir → 正在运行的微信进程打开的文件 → 各盘根目录。
    """
    # 1) 配置里手填的
    manual = ""
    try:
        with open(config_path or CONFIG_PATH, "r", encoding="utf-8-sig") as f:
            manual = str(((json.load(f).get("wechat") or {}).get("dbDir") or "")).strip()
    except Exception:
        manual = ""
    if manual and looks_like_db_root(manual):
        return manual

    # 2) 正在运行的微信进程打开着数据库文件 —— 直接反射出来，最准
    try:
        import psutil
        for proc in psutil.process_iter(["name"]):
            name = str(proc.info.get("name") or "").lower()
            if not any(k in name for k in ("weixin", "wechat")):
                continue
            try:
                open_files = proc.open_files()
            except Exception:
                continue
            for item in open_files:
                m = re.search(r"([\\/])(" + "|".join(DB_ROOT_NAMES) + r")([\\/]|$)",
                              item.path or "", re.I)
                if not m:
                    continue
                # 取「名字之前的那一段」作为盘符/目录，再拼回 xwechat_files
                root = (item.path or "")[: m.start() + 1] + m.group(2)
                if looks_like_db_root(root):
                    return root
    except Exception:
        pass

    # 3) 所有真实磁盘根（以前写死 C..K，L: 盘和网络盘永远找不到）
    for root in iter_drive_roots():
        for name in DB_ROOT_NAMES:
            cand = os.path.join(root, name)
            if looks_like_db_root(cand):
                return cand
    return ""


# ---------------------------------------------------------------------------
# 多账号：账号目录枚举 / 账号写法解析 / 给网页列账号
# ---------------------------------------------------------------------------

def find_account_dirs(db_dir):
    """列出 <db_dir> 下所有含 db_storage 的账号目录名。

    不能按 wxid_ 前缀判断：设了自定义微信号的账号目录名不一定以 wxid_ 开头。
    """
    out = []
    try:
        for name in os.listdir(db_dir):
            if os.path.isdir(os.path.join(db_dir, name, "db_storage")):
                out.append(name)
    except OSError:
        return []
    return sorted(out)


def account_wxid(account):
    """账号目录名去掉末尾 4 位哈希 = wxid（和 wechatauto 的 WeChatDB.wxid 同一套规则）。"""
    return re.sub(r"_\w{4}$", "", str(account or ""))


def resolve_account_dir(db_dir, wanted):
    """把配置/网页里的账号写法解析成真实账号目录名。

    依次尝试：完整目录名（wxid_xxx_cedb）→ 去掉 4 位哈希的 wxid（wxid_xxx）
    → 唯一前缀 → 昵称（要开库读 contact.db，慢，所以放最后）。
    返回目录名；匹配不到返回 ""。
    """
    wanted = str(wanted or "").strip()
    if not wanted or not db_dir:
        return ""
    names = find_account_dirs(db_dir)
    if not names:
        return ""
    if wanted in names:
        return wanted
    for n in names:
        if account_wxid(n) == wanted:
            return n
    hit = [n for n in names if n.lower().startswith(wanted.lower())]
    if len(hit) == 1:
        return hit[0]
    # 昵称匹配：只有前面都没命中才做（每个账号要开一次库，约 1 秒）
    try:
        from wechatauto import WeChatDB
    except Exception:
        return ""
    for n in names:
        try:
            probe = WeChatDB(db_dir=db_dir, account=n)
            if probe.account != n:
                continue                     # 库自己换号了，别用它的昵称
            info = probe.get_self_info() or {}
            nick = str(info.get("nick_name") or info.get("remark") or "").strip()
        except Exception:
            continue
        if nick and nick == wanted:
            return n
    return ""


def list_accounts_cli():
    """--list-accounts：扫描本机所有微信账号，写 data/accounts.json 给网页下拉用。

    昵称要开库读 contact.db（必须微信在登录、能取到密钥），所以是「尽力而为」：
    单个账号失败就留空，整件事最多花 20 秒，绝不因为读不到昵称就报错。
    """
    db_dir = resolve_db_dir()
    rows = []
    names = find_account_dirs(db_dir) if db_dir else []
    deadline = time.time() + 20
    try:
        from wechatauto import WeChatDB
    except Exception as e:                        # noqa: BLE001
        log("列账号：wechatauto 不可用，只列目录名：", repr(e))
        WeChatDB = None
    for n in names:
        item = {"account": n, "wxid": account_wxid(n), "nick": "", "lastActive": 0}
        base = os.path.join(db_dir, n, "db_storage")
        try:
            newest = 0.0
            for root, _dirs, files in os.walk(base):
                for f in files:
                    if f.endswith(".db") and not f.endswith(("-wal", "-shm")):
                        newest = max(newest, os.path.getmtime(os.path.join(root, f)))
            item["lastActive"] = int(newest * 1000)
        except Exception:
            pass
        if WeChatDB is not None and time.time() < deadline:
            try:
                probe = WeChatDB(db_dir=db_dir, account=n)
                if probe.account == n:
                    info = probe.get_self_info() or {}
                    item["nick"] = str(info.get("nick_name") or info.get("remark") or "").strip()
            except Exception:
                pass
        rows.append(item)
    rows.sort(key=lambda x: -x["lastActive"])
    payload = {
        "dbDir": db_dir or "",
        "generatedAt": int(time.time() * 1000),
        "accounts": rows,
    }
    path = os.path.join(ROOT, "data", "accounts.json")
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        log("列账号完成：%d 个（%s）" % (len(rows), "、".join(r["account"] for r in rows) or "无"))
    except Exception as e:                        # noqa: BLE001
        log("列账号：写 %s 失败：%r" % (path, e))
    print(json.dumps(payload, ensure_ascii=False))
    return 0


# 系统 / 公众号通知：只用来记录，不接话（否则会跟「微信团队」吵起来）
SYSTEM_SENDER_NAMES = {
    "微信团队", "微信支付", "服务通知", "订阅号消息", "文件传输助手",
    "微信运动", "微信公众平台", "腾讯客服", "微信安全中心", "微信广告",
}
try:
    SYSTEM_SENDER_NAMES |= {str(x).strip() for x in (_wechat.get("ignoreSenders") or []) if str(x).strip()}
except Exception:
    pass
_SYSTEM_TEXT_RE = __import__("re").compile(r"<a\s+href=|weixin://|&lt;a\s+href=", __import__("re").I)
# 同一会话同一句话的重复回复保护（秒）与每分钟回复上限
DUP_REPLY_WINDOW = 45
MAX_REPLIES_PER_MIN = 8
# 单实例锁端口：被占用就说明已经有桥接在跑，直接退出
BRIDGE_LOCK_PORT = 47821

# —— 语音识别（语音消息 → 文字）——
# 默认用阿里云百炼的 qwen3-asr-flash；Key 依次取 voice.apiKey → data/settings.json → deepseek.apiKey
VOICE_ENABLED = True
VOICE_BASE_URL = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation"
VOICE_MODEL = "qwen3-asr-flash"
VOICE_API_KEY = ""
VOICE_TIMEOUT = 90
VOICE_MAX_SECONDS = 120
VOICE_SAMPLE_RATE = 16000


def _resolve_voice_key(cfg):
    """语音 Key 的查找链：voice.apiKey → settings.voiceApiKey → settings.apiKey → config.deepseek.apiKey。

    以前只回退到 settings.apiKey，配置文件里写的 deepseek.apiKey 永远用不上（注释承诺了却没实现）；
    而且 reload_config 不刷新语音 Key，网页里换 Key 必须重启桥接才生效。
    """
    vo = (cfg.get("voice") or {}) if isinstance(cfg, dict) else {}
    key = str(vo.get("apiKey") or "").strip()
    if key:
        return key
    try:
        with open(os.path.join(ROOT, "data", "settings.json"), "r", encoding="utf-8-sig") as sf:
            st = json.load(sf)
        for name in ("voiceApiKey", "apiKey"):
            v = str(st.get(name) or "").strip()
            if v:
                return v
        keys = st.get("keys") or {}
        for name in ("vision", "qwen", "zhipu", "deepseek"):
            v = str(keys.get(name) or "").strip()
            if v:
                return v
    except Exception:
        pass
    try:
        v = str(((cfg.get("deepseek") or {}).get("apiKey") or "")).strip()
        if v:
            return v
    except Exception:
        pass
    return ""


try:
    _voice_cfg = (_cfg.get("voice") or {})
    VOICE_ENABLED = bool(_voice_cfg.get("enabled", True))
    VOICE_BASE_URL = str(_voice_cfg.get("baseUrl") or VOICE_BASE_URL)
    VOICE_MODEL = str(_voice_cfg.get("model") or VOICE_MODEL)
    VOICE_TIMEOUT = float(_voice_cfg.get("timeoutMs", 90000)) / 1000.0
    VOICE_MAX_SECONDS = float(_voice_cfg.get("maxSeconds", 120))
    VOICE_API_KEY = _resolve_voice_key(_cfg)
except Exception:
    pass


def asr_transcribe(wav_bytes, api_key, model, base_url, timeout=90):
    """把 wav 字节交给语音识别接口，返回文字；失败抛异常或返回空串。"""
    import base64
    import urllib.request

    if not api_key:
        raise RuntimeError("没有可用的语音识别 Key")
    payload = {
        "model": model,
        "input": {
            "messages": [{
                "role": "user",
                "content": [{"audio": "data:audio/wav;base64," + base64.b64encode(wav_bytes).decode()}],
            }]
        },
    }
    req = urllib.request.Request(
        base_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": "Bearer " + api_key, "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8", "replace"))
    try:
        text = data["output"]["choices"][0]["message"]["content"][0]["text"]
    except Exception:
        text = ""
    return str(text or "").strip()


def clean_transcript(text):
    """去掉只剩标点的转写结果。"""
    t = str(text or "").strip()
    t = t.strip("，,。.！!？?…~～、 ")
    return t if len(t) >= 1 else ""

_recent_dup = {}
_reply_stamps = {}
_guard_lock = threading.Lock()
# 「演示模式」提示只喊一次，别每条都刷
MOCK_NOTICED = {"done": False}


def is_system_notice(username, nickname, content):
    """系统号 / 通知类消息：带 weixin:// 链接、HTML 链接、或已知系统号名字。"""
    if _SYSTEM_TEXT_RE.search(str(content or "")):
        return True
    name = str(nickname or "").strip()
    if name in SYSTEM_SENDER_NAMES:
        return True
    uid = str(username or "")
    if uid.startswith("gh_"):
        return True
    return False


def duplicate_guard(chat_username, sender, content):
    """同一人 45 秒内重复同一句 → 不再回（微信重投/通知刷屏）。"""
    now = time.time()
    key = (str(chat_username or ""), str(sender or ""), str(content or "").strip())
    with _guard_lock:
        last = _recent_dup.get(key, 0)
        _recent_dup[key] = now
        if len(_recent_dup) > 500:
            for k, v in list(_recent_dup.items()):
                if now - v > 600:
                    _recent_dup.pop(k, None)
        return now - last < DUP_REPLY_WINDOW


def rate_guard(chat_username):
    """同一会话一分钟内已经回了 MAX_REPLIES_PER_MIN 条 → 先停下，避免越聊越乱。"""
    now = time.time()
    key = str(chat_username or "")
    with _guard_lock:
        stamps = [t for t in _reply_stamps.get(key, []) if now - t < 60]
        if len(stamps) >= MAX_REPLIES_PER_MIN:
            _reply_stamps[key] = stamps
            return False
        stamps.append(now)
        _reply_stamps[key] = stamps
    return True


BOOT_LOG = os.path.join(ROOT, "data", "bridge-boot.log")


def boot(msg):
    """启动诊断：只写文件，不依赖控制台（控制台被选中时 print 会卡住）"""
    try:
        os.makedirs(os.path.dirname(BOOT_LOG), exist_ok=True)
        with open(BOOT_LOG, "a", encoding="utf-8") as f:
            f.write("%s [pid %s] %s\n" % (time.strftime("%H:%M:%S"), os.getpid(), msg))
    except Exception:
        pass


boot("脚本开始执行")


def log(*args):
    line = time.strftime("[%H:%M:%S] ") + " ".join(str(a) for a in args)
    # 先写文件，再打印：这样即使控制台卡住，日志也不会丢
    try:
        os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass
    try:
        print(line, flush=True)
    except Exception:
        pass


_win_problem_ts = {}


def log_window_problem(where, err):
    """窗口操作失败两分钟内只报一次。

    挪不动/置顶不了窗口不该让整条发送失败（UIA 还能把字打进去），
    更不该让看门狗以为“发送卡住”把桥接反复重启——那会一直弹「拒绝访问」。
    """
    now = time.time()
    if now - _win_problem_ts.get(where, 0) < 120:
        return
    _win_problem_ts[where] = now
    log(where + "：", repr(err))


def read_config():
    cfg = {}
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8-sig") as f:
                cfg = json.load(f)
        except Exception as e:
            log("读取 config.json 失败：", e)
    return cfg


def build_bot_url(cfg):
    # 端口优先级：环境变量 > 服务写下的实际端口 > config.server.port
    # （服务用 --port= 启动时 config 里还是老端口，读文件才不会连错）
    port = (cfg.get("server") or {}).get("port", 8787)
    try:
        with open(os.path.join(ROOT, "data", "server-port.txt"), "r", encoding="utf-8") as _pf:
            _p = int((_pf.read() or "").strip())
            if 0 < _p < 65536:
                port = _p
    except Exception:
        pass
    return os.environ.get("WHALE_BOT_URL", "http://127.0.0.1:%s/webhook/wechat" % port)


def wait_for_server(url, timeout=30):
    """等本地服务真的在监听。

    用户最常见的坑：先点桥接、后点服务，或者两者同时启动。
    服务从进程起来到 listen() 完成要 1~3 秒，这段时间桥接每来一条消息就报
    「由于目标计算机积极拒绝，无法连接」。这里先等它起来，再开始监听。
    """
    import time as _t
    health = url.rsplit("/webhook", 1)[0] + "/healthz"
    deadline = _t.time() + max(5, timeout)
    waited = 0
    while _t.time() < deadline:
        try:
            r = LOCAL_HTTP.get(health, timeout=3)
            if r.status_code < 500:
                if waited > 0:
                    log("服务已就绪（等了 %d 秒）" % waited)
                return True
        except Exception:
            pass
        if waited == 0:
            log("等服务起来（最多 %d 秒）…" % timeout)
        _t.sleep(1)
        waited += 1
    log("[!] 等了 %d 秒服务还没起来。先双击「启动鲸鱼娘.bat」，再跑桥接。" % timeout)
    log("    提示：直接双击「先点启动鲸鱼娘再点启动桥接」文件夹里的两个 bat 就不会顺序错。")
    return False


def ensure_ffmpeg_env():
    """微信 4.x 的普通图片是 HEVC(wxgf) 容器，要 ffmpeg 才能转成 jpg。

    media 库用 shutil.which("ffmpeg") 找，很多机器装了 ffmpeg 但没加进 PATH，
    结果图片一直转不出来、看图全是「图片输入格式/解析错误」。
    这里先自己找一遍常见位置，找到就塞进 PATH。
    """
    import shutil
    if shutil.which("ffmpeg"):
        return True
    cands = [
        os.path.join(ROOT, "runtime", "ffmpeg", "bin"),
        os.path.join(ROOT, "tools", "ffmpeg", "bin"),
        r"C:\ffmpeg\bin", r"D:\ffmpeg\bin", r"E:\ffmpeg\bin", r"F:\ffmpeg\bin",
        os.path.expanduser(r"~\ffmpeg\bin"),
        os.path.expandvars(r"%LOCALAPPDATA%\Programs\ffmpeg\bin"),
        r"C:\Program Files\ffmpeg\bin", r"D:\Program Files\ffmpeg\bin",
    ]
    for d in cands:
        exe = os.path.join(d, "ffmpeg.exe")
        if os.path.isfile(exe):
            os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
            _bundled = os.path.join(ROOT, "runtime", "ffmpeg", "bin")
            log("找到 ffmpeg：", exe, "（包里自带，微信图片是 wxgf/HEVC，靠它转 jpg）" if exe.lower().startswith(_bundled.lower()) else "（微信图片是 wxgf/HEVC，靠它转 jpg）")
            return True
    log("[!] 没找到 ffmpeg：微信 4.x 的图片多是 wxgf/HEVC，没有它就看不了图。")
    log("    装一个（解压到 C:\\ffmpeg 即可）或把 ffmpeg.exe 放进 runtime\\ffmpeg\\bin")
    return False


try:
    from .msg_pipeline import MessagePipeline
except ImportError:                                  # 以脚本方式跑（bridge/ 在 sys.path 上）
    from msg_pipeline import MessagePipeline

def _bg_cli(argv=None):
    """零焦点通道的命令行自检 / 发送。

    ```
    python -m bridge --bg-probe                 只读自检：物化、读控件、前后前台
    python -m bridge --bg-send "测试" --to 文件传输助手
    ```

    放在 main() 最前面（和 --list-accounts 一样），不抢单实例锁，
    所以桥接正跑着的时候也能用。
    """
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        import bg_sender
    except Exception:
        try:
            from . import bg_sender          # type: ignore
        except Exception as e:               # noqa: BLE001
            log("导入 bg_sender 失败：", repr(e))
            return 1

    if "--bg-send" in argv:
        i = argv.index("--bg-send")
        text = argv[i + 1] if len(argv) > i + 1 else ""
        to = None
        if "--to" in argv:
            j = argv.index("--to")
            to = argv[j + 1] if len(argv) > j + 1 else None
        ok, why = bg_sender.send(text, chat=to, log=log,
                                 char_gap=BG_SEND["charGap"],
                                 strip_unencodable=BG_SEND["strip"],
                                 verify=BG_SEND["verify"],
                                 unhide=BG_SEND["unhide"],
                                 char_mode=BG_SEND.get("charMode") or "auto")
        log("发送 = %s（%s）" % (ok, why))
        return 0 if ok else 1

    res = bg_sender.probe(log=log)
    return 0 if res.get("edit") else 1


def main():
    boot("进入 main()")
    # 给网页「设置 → 微信账号」下拉用：只扫账号、不连消息，跑完就退出。
    # 必须放在单实例锁之前 —— 否则桥接正跑着的时候，这条命令会以为自己"重复启动"直接退出。
    if "--list-accounts" in sys.argv:
        return list_accounts_cli()
    if "--bg-probe" in sys.argv or "--bg-send" in sys.argv:
        return _bg_cli()
    # 零焦点通道要求 UIA 的物理像素坐标和 ScreenToClient 用同一套 DPI 上下文，
    # 所以尽量在创建任何窗口之前把进程切成 per-monitor aware（切不动会自动降级）。
    try:
        import bg_sender
        bg_sender.ensure_dpi_aware()
    except Exception:
        pass
    ensure_ffmpeg_env()
    # 权限自检：微信 4.x 的控件树和 PostMessage 都受 UIPI 约束。桥接比微信低一级时
    # 零焦点通道会静默失败（节点数 0），只剩会抢前台的旧通道。
    try:
        import ctypes
        if not ctypes.windll.shell32.IsUserAnAdmin():
            log("[!] 当前不是管理员：如果微信也是管理员运行的，零焦点发送会用不了（UIPI）。")
            log("    用「启动微信桥接.bat」启动会自动提权；手动跑请右键「以管理员身份运行」。")
    except Exception:
        pass
    # 微信的 Qt accessibility 只在「纯英文路径」下能热激活成功；路径里带中文时，
    # UIA 认不出主窗（ensure_window 超时 37s），之后每次发送都退到 OCR 并报
    # error(5, 'SetWindowPos', '拒绝访问')，日志刷屏、消息发不出去。
    if any(ord(ch) > 127 for ch in ROOT):
        log("[!] 路径里有中文/非英文字符：", ROOT)
        log("    微信 UI 自动化在这种路径下会失败（发送一直报「拒绝访问」）。")
        log("    请把整个文件夹移到纯英文路径再启动，例如 D:\\whale-girl-3.0")
    # 单实例锁：多个桥接连同一份微信数据库会导致同一条消息被回好几遍
    _lock_sock = None
    try:
        import socket as _socket
        _lock_sock = _socket.socket(_socket.AF_INET, _socket.SOCK_STREAM)
        _lock_sock.setsockopt(_socket.SOL_SOCKET, _socket.SO_REUSEADDR, 0)
        _lock_sock.bind(("127.0.0.1", BRIDGE_LOCK_PORT))
        _lock_sock.listen(1)
        boot("单实例锁已获取（端口 %d）" % BRIDGE_LOCK_PORT)
    except OSError as e:
        log("已经有一个桥接在跑了（端口 %d 被占用），本进程退出：%r" % (BRIDGE_LOCK_PORT, e))
        try:
            if _lock_sock:
                _lock_sock.close()
        except Exception:
            pass
        return 0
    except Exception:
        _lock_sock = None
    try:
        import faulthandler

        try:
            _hang_file = open(os.path.join(ROOT, "data", "bridge-hang.log"), "a", encoding="utf-8")
            faulthandler.dump_traceback_later(40, repeat=True, file=_hang_file)
            boot("已开启卡死堆栈转储（40s）")
        except Exception:
            pass

        # 原生崩溃（0xC0000005）发生时，让 faulthandler 尽量在死前吐出当时正在跑哪句，
        # 写进 data/bridge-crash.log。能吐出来就省得猜是 UIA 还是别的什么崩的。
        try:
            _crash_file = open(os.path.join(ROOT, "data", "bridge-crash.log"), "a", encoding="utf-8")
            _crash_file.write("\n==== %s 进程启动（pid=%d）====\n" % (time.strftime("%Y-%m-%d %H:%M:%S"), os.getpid()))
            _crash_file.flush()
            faulthandler.enable(file=_crash_file, all_threads=True)
            boot("已开启崩溃堆栈记录（data/bridge-crash.log）")
        except Exception:
            pass

        boot("开始 import requests")
        import requests

        boot("开始 import wechatauto（可能较慢，10~20 秒）")
        from wechatauto import MediaDownloader, WeChatDB, WeChatGUI
        from wechatauto.db import Listener

        # 小版本兼容补丁：本机微信上 UIA 控件树其实已经物化，但顶层窗口类名不是
        # mmui::MainWindow，wechatauto 自带的判断会把它当成「没物化」，于是每次
        # 发送都跳过 UIA、掉进会卡死在截屏里的 OCR 兜底。补丁见 uia_compat.py。
        # 包里自带的 Python 开了 safe_path（sys.flags.safe_path=True，sys.path[0]
        # 是 python312.zip 而不是脚本目录），所以同目录的 uia_compat 直接 import 会
        # ModuleNotFoundError。这里显式把 examples 目录塞进 sys.path；再不行就按
        # 文件路径加载（双保险）。
        _here = os.path.dirname(os.path.abspath(__file__))
        if _here not in sys.path:
            sys.path.insert(0, _here)
        # 打开每一步的耗时日志（uia step xxx -> X.XXs），下次卡住能直接看出停在哪步
        os.environ.setdefault("WHALE_STEPLOG", "1")
        boot("应用 uia_compat 补丁")
        try:
            import uia_compat
            boot("uia_compat.apply() = %r" % (uia_compat.apply(),))
        except Exception as _compat_err:
            try:
                import importlib.util as _ilu
                _spec = _ilu.spec_from_file_location(
                    "uia_compat", os.path.join(_here, "uia_compat.py"))
                _mod = _ilu.module_from_spec(_spec)
                sys.modules["uia_compat"] = _mod
                _spec.loader.exec_module(_mod)
                _mod.apply()
                boot("uia_compat 已按文件路径加载并生效")
            except Exception:                # noqa: BLE001
                boot("uia_compat 未生效: %r" % (_compat_err,))

        boot("import 完成")
    except Exception as e:
        boot("导入失败: %r" % (e,))
        log("缺少依赖或导入失败：", e)
        _msg = "%s %s" % (type(e).__name__, e)
        _dll_issue = (
            isinstance(e, OSError)
            or ("DLL load failed" in _msg)
            or ("WinError 126" in _msg)
            or ("WinError 127" in _msg)
            or ("找不到指定的模块" in _msg)
            or ("mfc" in _msg.lower())
            or ("vcruntime" in _msg.lower())
        )
        if _dll_issue:
            # Windows Server 默认不带 MFC/VC++ 运行库，wechatauto-replica 的原生模块就加载不了。
            # 以前这里一律让人 pip install，等于把用户带到沟里。
            log("")
            log("[!] 这不是缺 Python 包，是本机缺 VC++ 运行库（wechatauto-replica 的原生模块要用）。")
            log("    装这个（选 x64）：https://aka.ms/vs/17/release/vc_redist.x64.exe")
            log("    装完重启电脑，再双击「启动微信桥接.bat」。")
            log("    提示：Windows Server 默认不装 MFC，家庭版/专业版一般已有。")
        else:
            log("请先运行：\"%LOCALAPPDATA%\\Programs\\Python\\Python312\\python.exe\" -m pip install wechatauto-replica requests")
        return 1

    cfg = read_config()
    gw = (cfg.get("gateway") or {}).get("wechat") or {}
    token = gw.get("inboundToken", "")
    bot_url = build_bot_url(cfg)
    aliases = ((cfg.get("persona") or {}).get("aliases") or []) + [
        ((cfg.get("persona") or {}).get("name") or "鲸鲸")
    ]

    log("引用回复：%s（关掉更快，需要时在 config.json 把 wechat.quoteReply 设 true）" % ("开" if QUOTE_REPLY else "关"))
    log("连接微信 4.x 数据库（只读）…")
    # token 一定要读到：读不到就是「她不理人」最隐蔽的原因（服务端会直接 401）
    if token:
        log("webhook token：已读取（%s…）" % token[:6])
    else:
        log("⚠️ webhook token 是空的！检查 config.json 的 gateway.wechat.inboundToken（文件要能正常解析）")
    db_dir = resolve_db_dir()
    if db_dir:
        log("数据库目录：", db_dir)
    # 多账号/双开：一定要把账号钉死。默认的「最近活跃库」启发式会选到另一个号
    # （大号天天在用 → 库最新 → 拿小号的配置去大号里发消息）。
    acct_dirs = find_account_dirs(db_dir) if db_dir else []
    acct = ACCOUNT_WANTED
    if acct:
        hit = resolve_account_dir(db_dir, acct) if db_dir else ""
        if not hit:
            log("")
            log("✗ 找不到微信账号 %r。" % acct)
            log("  这台机器上现有账号：%s" % ("、".join(acct_dirs) or "（一个都没有）"))
            log("  去网页「设置 → 微信账号」里重新选一个，或把 config.json 的")
            log("  wechat.account 改成上面某个名字（目录名 / wxid / 昵称都行，留空=自动选）。")
            log("  这里直接停下，不会偷偷换成别的号。")
            return 2
        if hit != acct:
            log("配置账号 %r → 账号目录 %s" % (acct, hit))
        acct = hit
        log("指定账号：", acct, "（网页设置 / config.json → wechat.account）")
    elif len(acct_dirs) > 1:
        log("⚠️ 这台机器有 %d 个微信账号：%s" % (len(acct_dirs), "、".join(acct_dirs)))
        log("   没指定账号 → 按「最近活跃」自动选，可能选到大号。")
        log("   去网页「设置 → 微信账号」里选一个（推荐：只选小号）。")

    # 打开微信数据库偶尔会「卡住不返回」（wechatauto-replica 内部去找微信进程/取密钥时挂住），
    # 表现就是「重启了但一直不监听」。这里给它 90 秒上限，超时明确报错退出。
    def _open_db_with_timeout(timeout=90):
        box = {}

        def _work():
            try:
                # 账号在这里一并钉死：不传 account 的话库会按「最近活跃」自己挑一个
                box["db"] = (
                    WeChatDB(db_dir=db_dir, account=acct or None)
                    if db_dir
                    else WeChatDB(account=acct or None)
                )
            except BaseException as exc:      # noqa: BLE001
                box["err"] = exc

        th = threading.Thread(target=_work, name="open-db", daemon=True)
        th.start()
        th.join(timeout)
        if th.is_alive():
            box["timeout"] = True
        return box

    log("打开微信数据库（这一步偶尔会卡，最多等 90 秒）…")
    _db_box = _open_db_with_timeout(90)
    if _db_box.get("timeout"):
        log("")
        log("✗ 打开微信数据库卡住超过 90 秒，已放弃这次启动（不是崩溃，是卡死）。")
        log("  常见原因：微信没完全登录 / 数据库被占用 / 微信正在更新。")
        log("  处理：确认微信已登录 → 重启微信 → 再双击「启动微信桥接.bat」。")
        log("  如果反复卡住，把 data\\bridge-hang.log 和这段日志发给作者。")
        return 2
    db = _db_box.get("db")
    _db_err = _db_box.get("err")
    try:
        if _db_err is not None:
            raise _db_err
    except RuntimeError as e:
        # 不甩 traceback：告诉用户接下来该点哪里
        log("")
        log("✗ 找不到微信的数据库目录，读不到消息。按顺序检查：")
        log("  1) 微信 4.x 是不是已经登录了？（停在扫码/登录界面时还没有数据库）")
        log("  2) 微信 → 左下角三条杠 → 设置 → 文件管理 → 「微信文件默认保存位置」")
        log("     把那个路径填进 config.json：\"wechat\": { \"dbDir\": \"E:\\\\xwechat_files\" }")
        log("     （填到 xwechat_files 这一层，不是里面的 wxid_xxx 目录）")
        log("  3) 保存后重新运行「启动微信桥接.bat」")
        log("  原始错误：%s" % e)
        return 2

    # 建库后硬断言：指定了账号就必须真的是那个账号。
    # wechatauto 在「密钥解不开当前号」时会把 account 换成另一个号（_try_other_accounts），
    # 不拦的话就会变成「读小号、写大号」。宁可停下，也不带着错号跑。
    if acct and db.account != acct:
        log("")
        log("✗ 账号被库自己换掉了：要的是 %s，实际打开的是 %s。" % (acct, db.account))
        log("  多半是微信当前登录的是另一个号，取到的密钥解不开 %s 的库。" % acct)
        log("  请确认微信现在登录的就是小号，再重启「启动微信桥接.bat」。")
        log("  （这里直接停下，绝不会用 %s 继续跑。）" % db.account)
        return 2
    _media_box = {"downloader": None}
    _media_lock = threading.Lock()

    def _get_media():
        """按需创建媒体下载器；图片和表情识别共用一个实例。

        多条消息现在会并发识别图片，所以创建过程要加锁：否则会同时 new 出
        两个 MediaDownloader，各自往同一个缓存目录里落文件。
        """
        with _media_lock:
            if _media_box["downloader"] is not None:
                return _media_box["downloader"]
            save_dir = os.path.join(ROOT, "data", "media-cache")
            os.makedirs(save_dir, exist_ok=True)
            dl = MediaDownloader(db, save_dir=save_dir)
            # 微信改过「文件保存位置」后，图片缓存可能留在旧目录（msg/attach），而
            # 数据库已经搬到了新位置。这时只看 db.account_dir 图片就永远找不到：
            # 「图片识别只认默认微信文件地址，改了就不行」就是这个原因。
            # 加一层只读兜底：当前目录找不到，就按会话 md5 去其它账号目录/盘里找。
            try:
                from media_fallback import install_media_fallback
                installed = install_media_fallback(
                    dl, db, log=log,
                    root_names=DB_ROOT_NAMES,
                )
                if installed:
                    log("图片目录兜底已就位（%d 处补丁）" % installed)
            except Exception as _e:
                log("图片目录兜底没装上（默认路径不受影响）：", repr(_e))
            _media_box["downloader"] = dl
            return dl

    me = db.wxid
    _self_nick = ""
    try:
        info = db.get_self_info() or {}
        _self_nick = str(info.get("nick_name") or info.get("remark") or "").strip()
        log("当前登录账号：", _self_nick or me)
    except Exception:
        log("当前登录账号 wxid：", me)
    log("账号目录：", db.account, "（网页/config 指定）" if acct else "（自动选：最近活跃）")
    if len(acct_dirs) > 1:
        log("（这台机器有 %d 个账号目录：%s）" % (len(acct_dirs), "、".join(acct_dirs)))
    log("数据库目录：", db.db_dir)

    sessions = {}
    try:
        for s in db.get_sessions(limit=800):
            sessions[s["username"]] = s
    except Exception as e:
        log("读取会话列表失败：", e)

    name_cache = {}

    def display_name(username):
        if username in name_cache:
            return name_cache[username]
        name = ""
        try:
            if username.endswith("@chatroom"):
                name = db.group_id_to_name(username) or ""
                if not name:
                    s = sessions.get(username) or {}
                    name = s.get("last_sender") or ""
            else:
                name = db.get_nickname(username) or ""
        except Exception:
            name = ""
        name = name or username
        name_cache[username] = name
        return name

    alias_cache = {}
    # 上次把这个会话切到哪一行名字（微信里没命名的群，行名是成员名）
    open_cache = {}

    def aliases_for(username, shown=""):
        """会话列表里那一行可能叫什么（微信里没命名的群，显示的是成员名）。

        实测：群 12345678901@chatroom 在数据库里 nick_name 是空的，会话列表里显示
        「成员甲、成员乙『示例群』」—— 按群名/open_chat 都匹配不上，所以这里把
        「成员名用、连起来」也当候选名。
        """
        key = (username or "", shown or "")
        if key in alias_cache:
            return alias_cache[key]
        out = []
        if shown and shown != username and not str(shown).endswith("@chatroom"):
            out.append(shown)
        if username and str(username).endswith("@chatroom"):
            try:
                nm = db.group_id_to_name(username) or ""
            except Exception:
                nm = ""
            if nm and nm != username:
                out.append(nm)
            try:
                nicks = []
                for m in (db.get_group_members(username) or []):
                    if m.get("username") == me:
                        continue
                    n = (m.get("remark") or "").strip() or (m.get("nick_name") or "").strip()
                    if n:
                        nicks.append(n)
                if nicks:
                    out.append("、".join(nicks))
            except Exception:
                pass
        if not out:
            out.append(shown or username)
        out = [x for x in dict.fromkeys(out) if x]
        alias_cache[key] = out
        return out

    def chat_latest_seq(username):
        try:
            rows = db.get_messages(username, limit=1)
            return rows[0].get("sort_seq") or 0 if rows else 0
        except Exception:
            return 0

    gui = None
    gui_lock = threading.Lock()
    send_lock = threading.Lock()
    dead_chats = set()
    fail_streak = {}
    self_wxid = db.wxid
    pending_replies = {}
    SEND_STATE = {"active": False, "start": 0.0}
    pending_lock = threading.Lock()
    AWAY = {"on": False}
    NOTIFIED = []

    # ---------- 多账号：把「读」和「发」钉在同一个号上 ----------
    # 微信 4.x 一个号一个进程，每个进程的主窗标题都叫「微信」。老逻辑按窗口面积挑，
    # 双开时挑中的往往是窗口更大的大号：
    #   读的是小号的库 → 收到「主人：你好」
    #   发的是大号的窗口 → 搜索结果里点到同名会话，回复从大号发了出去
    # 这里用「库里最近会话」反查窗口：哪个窗口的会话列表对得上这个账号，就钉哪个；
    # 一个都对不上就不发（宁可哑着，也不能从别人的号把私聊发出去）。
    ACCOUNT = {"hwnd": 0, "verified": False, "why": "", "label": ""}

    def _compat_mod():
        return sys.modules.get("uia_compat")

    def _account_recent_names(limit=12):
        """这个账号最近的会话名（用来和窗口里看得见的会话行做比对）。"""
        want = []
        try:
            rows = db.get_sessions(limit=limit) or []
        except Exception as e:                    # noqa: BLE001
            log("账号窗口：读会话列表失败：", repr(e))
            return want
        for s in rows:
            u = s.get("username") or ""
            try:
                nm = display_name(u)
            except Exception:                     # noqa: BLE001
                nm = ""
            if nm and nm != u:
                want.append(nm)
        return want

    def _probe_wechat_windows():
        """[(hwnd, 控件, 可见会话行名...)]：纯只读，不点任何东西。

        先对每个主窗热激活 mmui 树（只写 accessibility gate 字节，不置前、不点击），
        否则刚启动时子控件还是空的，读不到会话行。
        """
        import win32gui
        import win32process
        from wechatauto.uia_driver import WeChatUIA
        ensure_uia_ready()
        probe = WeChatUIA()
        out = []
        try:
            hwnds = list(probe._wechat_hwnds() or ())
        except Exception:                         # noqa: BLE001
            hwnds = []
        # 只认「PID 里真的加载了 Weixin.dll」的窗口：微信更新/重启后旧句柄会被
        # 回收，拿它去热激活只会得到「未找到 Weixin.dll」然后无限重试。
        good = 0
        if uia_boot is not None:
            try:
                _w = uia_boot.pick_window(int(ACCOUNT.get("hwnd") or 0))
                if _w:
                    good = int(_w["hwnd"])
                    if int(ACCOUNT.get("hwnd") or 0) != good:
                        ACCOUNT["hwnd"] = good
                        log("微信主窗已重新定位：hwnd=%s pid=%s" % (good, _w.get("pid")))
            except Exception:                     # noqa: BLE001
                good = 0
        for h in hwnds:
            h = int(h)
            try:
                cls = win32gui.GetClassName(h) or ""
                title = (win32gui.GetWindowText(h) or "").strip()
                if good and h != good:
                    continue
            except Exception:                     # noqa: BLE001
                cls, title = "", ""
            # 托盘消息窗/工具窗也带 Qt 类名，只有真主窗是 QWindowIcon 或 mmui::MainWindow
            if not ("QWindowIcon" in cls or "mmui::" in cls):
                continue
            # 「设置」窗、独立聊天窗、群公告弹窗也都是 QWindowIcon，但标题不是「微信」。
            # 以前把它们当主窗统计，日志会出现「本机有 2 个微信主窗」的假多开。
            if title != "微信":
                continue
            try:
                probe._hot_activate_accessibility(h)
            except Exception:                     # noqa: BLE001
                pass
            c = None
            rows = []
            for _try in range(2):
                try:
                    c = probe._anchor(h)
                except Exception:                 # noqa: BLE001
                    c = None
                rows = []
                if c is not None and hasattr(probe, "_session_rows_of"):
                    try:
                        rows = [nm for nm, _ctl in probe._session_rows_of(c)]
                    except Exception:             # noqa: BLE001
                        rows = []
                if rows:
                    break
                time.sleep(0.4)
            out.append((h, c, rows))
        return probe, out

    def bind_gui_window(g):
        """把 WeChatGUI 的坐标/OCR 目标也对齐到锁定的账号窗口。"""
        if g is None:
            return g
        if ACCOUNT.get("hwnd"):
            try:
                g.use_window(ACCOUNT["hwnd"])
            except Exception:                     # noqa: BLE001
                pass
        return g

    def rebind_uia(hwnd, engine=None):
        """把 UIA 引擎 + uia_compat 的钉窗 + GUI 目标全部对齐到 hwnd。"""
        hwnd = int(hwnd or 0)
        if not hwnd:
            return False
        m = _compat_mod()
        if m is not None:
            try:
                m.pin_window(hwnd)
            except Exception:                     # noqa: BLE001
                pass
        targets = []
        if engine is not None:
            targets.append(engine)
        try:
            if UIA_CACHE.get("u") is not None:
                targets.append(UIA_CACHE["u"])
        except Exception:                         # noqa: BLE001
            pass
        for u in targets:
            try:
                u._pinned_hwnd = hwnd
                u._win = u._anchor(hwnd) or u._win
            except Exception:                     # noqa: BLE001
                pass
        try:
            if gui is not None:
                gui.use_window(hwnd)
        except Exception:                         # noqa: BLE001
            pass
        return True

    def pick_account_window(force=False, quiet=False):
        """确认哪个微信窗口是 config/网页指定的账号，并钉死它。"""
        if ACCOUNT["verified"] and not force:
            return True
        # 手动钉窗优先（config.json → wechat.windowHwnd）
        if WINDOW_HWND:
            try:
                import win32gui
                if win32gui.IsWindow(WINDOW_HWND):
                    ACCOUNT.update(hwnd=WINDOW_HWND, verified=True,
                                   label="hwnd=%s（配置）" % WINDOW_HWND,
                                   why="config.wechat.windowHwnd")
                    m = _compat_mod()
                    if m is not None:
                        try:
                            m.pin_window(WINDOW_HWND)
                        except Exception:         # noqa: BLE001
                            pass
                    if not quiet:
                        log("账号窗口：按 config 的 wechat.windowHwnd=%s 直接锁定" % WINDOW_HWND)
                    return True
            except Exception:                     # noqa: BLE001
                pass
        probe, cands = _probe_wechat_windows()
        if not cands:
            ACCOUNT.update(verified=False, hwnd=0, why="没扫到微信主窗")
            return False
        if len(cands) == 1:
            h, _c, _rows = cands[0]
            ACCOUNT.update(hwnd=h, verified=True, label="hwnd=%s" % h,
                           why="本机只登了一个号")
            m = _compat_mod()
            if m is not None:
                try:
                    m.pin_window(h)
                except Exception:                 # noqa: BLE001
                    pass
            if not quiet:
                log("账号窗口：只有一个微信主窗（hwnd=%s），直接用它" % h)
            return True

        want = _account_recent_names()
        log("账号窗口：本机有 %d 个微信主窗，按账号 %s 的最近会话认窗口：%s"
            % (len(cands), db.account, " / ".join(want[:6]) or "（空）"))
        for h, _c, rows in cands:
            log("   hwnd=%s 可见 %d 行：%s"
                % (h, len(rows), " | ".join(rows[:6]) or "（读不到会话列表）"))

        score_fn = getattr(probe, "_row_score", None)
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
                        except Exception:         # noqa: BLE001
                            continue
                    elif r.strip() == str(nm).strip():
                        hits.append(i)
                        break
            scored.append((bool(hits and hits[0] == 0), len(hits), h, c, rows))
        if not scored:
            ACCOUNT.update(verified=False, hwnd=0,
                           why="每个微信窗口都读不到会话列表")
            return False
        scored.sort(key=lambda x: (x[0], x[1]), reverse=True)
        newest_ok, nhit, h, _c, rows = scored[0]
        if sum(1 for candidate in scored if candidate[:2] == scored[0][:2]) != 1:
            ACCOUNT.update(verified=False, hwnd=0,
                           why="多个微信窗口的账号证据相同，不能唯一确认")
            return False
        if not newest_ok:
            best_hits = scored[0][1]
            tied = [x for x in scored if x[1] == best_hits]
            if best_hits < 2 or len(tied) > 1:
                ACCOUNT.update(verified=False, hwnd=0,
                               why="没有一个窗口对得上账号 %s 的最近会话" % db.account)
                return False

        ACCOUNT.update(hwnd=h, verified=True, label="hwnd=%s" % h,
                       why="命中最近会话 %d 条" % nhit)
        m = _compat_mod()
        if m is not None:
            try:
                m.pin_window(h)
            except Exception as e:                # noqa: BLE001
                log("账号窗口：pin_window 失败：", repr(e))
        log("账号窗口：锁定 hwnd=%s（%d 个窗口里对上 %d 条最近会话%s）"
            % (h, len(scored), nhit, "，最新一条也在" if newest_ok else ""))
        return True

    def ensure_account_window(engine=None):
        """发送前确认「锁定的微信窗口」还活着；微信重启/换号后自动重认。

        不这么做的话：微信重开一次，hwnd 变了，而 ACCOUNT["verified"] 还是 True，
        于是每次发送都被「引擎窗口和锁定窗口不一致」拦下、连失败两次后会话被标死。
        """
        hw = int(ACCOUNT.get("hwnd") or 0)
        alive = False
        if hw:
            try:
                import win32gui
                alive = bool(win32gui.IsWindow(hw))
            except Exception:                     # noqa: BLE001
                alive = False
        if ACCOUNT.get("verified") and alive:
            # uia_compat 那边发现旧 hwnd 死了会把钉窗清掉，这里补回去，
            # 否则下一次找主窗又会按面积挑，可能挑到别的号。
            m = _compat_mod()
            if m is not None:
                try:
                    if int(m.pinned_window() or 0) != hw:
                        rebind_uia(hw, engine)
                        log("账号窗口：UIA 钉窗和锁定窗口不一致，已钉回 hwnd=%s" % hw)
                except Exception:                 # noqa: BLE001
                    pass
            return True
        if hw and not alive:
            log("⚠️ 锁定的微信窗口 hwnd=%s 已经不在了（微信重启/换号），重新认账号…" % hw)
            ACCOUNT.update(verified=False, why="锁定窗口已失效")
        try:
            ok = pick_account_window(force=True, quiet=True)
        except Exception as e:                    # noqa: BLE001
            log("重新认账号失败：", repr(e))
            return False
        if not ok:
            return False
        rebind_uia(ACCOUNT.get("hwnd"), engine)
        log("账号窗口已重新锁定 hwnd=%s（%s）"
            % (ACCOUNT.get("hwnd"), ACCOUNT.get("why") or ""))
        return True

    def account_send_allowed(where, engine=None):
        """统一的发送闸：认不出目标账号窗口就不发。"""
        if ensure_account_window(engine):
            return True
        if ACCOUNT_GUARD:
            ACCOUNT["blockedAt"] = time.time()
            log("⚠️ 不发送（%s）：没能确认哪个微信窗口是账号 %s（%s）；"
                "现在可能同时登着别的号，乱发会从别人的号发出去。"
                % (where, db.account, ACCOUNT["why"] or "未知"))
            return False
        return True

    def away_active():
        """主人在微信里发了「我去玩了」→ 写 data/away.json，这里据此静默排队。"""
        try:
            p = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "away.json")
            with open(p, "r", encoding="utf-8") as f:
                d = json.load(f)
            return float(d.get("until") or 0) > time.time()
        except Exception:
            return False

    def game_running():
        if not GAME_TOKENS:
            return False
        try:
            import psutil
            for p in psutil.process_iter(["name"]):
                n = (p.info.get("name") or "").lower()
                if any(t in n for t in GAME_TOKENS):
                    return True
        except Exception:
            pass
        return False

    def foreground_is_fullscreen():
        """前台是不是「真全屏」程序（全屏游戏、全屏视频）——这时别抢焦点，先把回复排着。

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
            if name.startswith("weixin"):
                return False
            style = win32gui.GetWindowLong(h, win32con.GWL_STYLE)
            if (style & win32con.WS_CAPTION) and (style & win32con.WS_THICKFRAME):
                return False        # 普通窗口或最大化：有标题栏+可调边框，不是全屏

            class _MONITORINFO(ctypes.Structure):
                _fields_ = [("cbSize", wt.DWORD), ("rcMonitor", wt.RECT),
                            ("rcWork", wt.RECT), ("dwFlags", wt.DWORD)]

            user32 = ctypes.windll.user32
            mi = _MONITORINFO()
            mi.cbSize = ctypes.sizeof(_MONITORINFO)
            hmon = user32.MonitorFromWindow(h, 2)  # MONITOR_DEFAULTTONEAREST
            if not user32.GetMonitorInfoW(hmon, ctypes.byref(mi)):
                return False
            mon = mi.rcMonitor
            r = win32gui.GetWindowRect(h)
            return (r[0] <= mon.left + 1 and r[1] <= mon.top + 1
                    and r[2] >= mon.right - 1 and r[3] >= mon.bottom - 1)
        except Exception:
            return False

    def group_is_alive(chat_username):
        """被踢出群后，群会话还在，但发不出去；先查成员列表。"""
        if not str(chat_username).endswith("@chatroom"):
            return True
        try:
            members = db.get_group_members(chat_username) or []
            ids = {str(m.get("wxid") or m.get("username")) for m in members}
            return self_wxid in ids
        except Exception:
            return True

    # ---------- 微信窗口置顶（关键：别的窗口挡在微信上面会导致打字落空） ----------
    def find_weixin_hwnd():
        try:
            import win32gui
            import win32con
            import win32process
            import psutil
        except Exception:
            return 0
        found = []
        # 微信（4.x / Qt）会额外建一个「托盘图标隐藏消息窗」：它算可见窗口，
        # 而且 GetWindowRect 出来的面积常常比主窗还大（实测 1320x900 > 主窗 896x776）。
        # 以前按「面积最大」挑，就会挑中它 —— 对它 SetWindowPos 直接 error(5) 拒绝访问，
        # 于是每次发送都失败、走 OCR 兜底、再被看门狗重启，一直循环报「拒绝访问」。
        BAD_CLASS = ("trayicon", "messagewindow", "msctf", "sopy", "sogou", "hintwnd", "default ime", "notifyicon")

        def cb(h, _):
            try:
                title = win32gui.GetWindowText(h) or ""
                _, pid = win32process.GetWindowThreadProcessId(h)
                if pid <= 0:
                    return
                cls = win32gui.GetClassName(h) or ""
                low = cls.lower()
                if any(bad in low for bad in BAD_CLASS):
                    return
                rect = win32gui.GetWindowRect(h)
                area = max(0, rect[2] - rect[0]) * max(0, rect[3] - rect[1])
                if win32gui.IsIconic(h):
                    # 最小化后 GetWindowRect 是 (-16000,-16000,…) 的退化矩形，
                    # 换算成「还原后」的尺寸再判大小
                    try:
                        rc = win32gui.GetWindowPlacement(h)[4]
                        area = max(0, rc[2] - rc[0]) * max(0, rc[3] - rc[1]) or area
                    except Exception:
                        pass
                # 不再要求 IsWindowVisible：微信缩在托盘里时主窗 visible=0，以前这里
                # 直接 return，于是整条「置顶 + 调窗口」都被跳过。主窗至少 300x250，
                # 托盘提示窗（260x85）和辅助窗（173x196）顺手被排除。
                if area < 300 * 250 and title.strip() != "微信":
                    return
                try:
                    name = psutil.Process(pid).name().lower()
                except Exception:
                    return
                if not name.startswith("weixin"):
                    return
                if "发送" in title or "助手" in title:
                    return
                try:
                    style = win32gui.GetWindowLong(h, win32con.GWL_STYLE)
                    has_min_box = bool(style & win32con.WS_MINIMIZEBOX)
                except Exception:
                    has_min_box = False
                is_main_title = title.strip() == "微信"
                looks_main_class = ("qwindowicon" in low) or ("mmui::mainwindow" in low)
                # 真主窗的三条特征都各加一个大权重，面积只在同类里起作用，
                # 这样托盘消息窗再“大”也排不到前面
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

    def wechat_window_alive():
        """微信主窗现在是否还存在（每次现找，不缓存 —— 微信窗口回收/更新后，缓存句柄会失效）。

        长时间挂着不管时，微信可能半夜自更新、或把窗口拆了重开，此时 uiautomation
        手里还攥着旧窗口的 COM 指针 / 句柄，再碰一次就直接 0xC0000005（访问违规），
        Python 的 try/except 拦不住，进程当场死掉 —— 也就是「Bridge exited with code
        -1073741819」。这些 UIA 调用前先问一句窗口还在不在，就能把这种崩溃挡在外面。
        """
        try:
            import win32gui
            # 多账号：钉住之后只认钉住的那个窗口，别拿「另一个号的主窗」当活着的证据
            h = int(ACCOUNT.get("hwnd") or 0) or find_weixin_hwnd()
            return bool(h and win32gui.IsWindow(h))
        except Exception:
            return False

    def normalize_window(hwnd):
        """微信窗口太小 / 超出屏幕 / 被挪走都会让 UI 自动化点空，统一调成稳定尺寸。"""
        try:
            import win32gui
            import win32con
            import win32api
            sw, sh = win32api.GetSystemMetrics(0), win32api.GetSystemMetrics(1)
            rect = win32gui.GetWindowRect(hwnd)
            x, y, w, h = rect[0], rect[1], rect[2] - rect[0], rect[3] - rect[1]
            tw, th = min(1320, sw - 160), min(900, sh - 160)
            need = w < 1080 or h < 760 or w > sw - 80 or h > sh - 80 or x < -20 or y < -20 or x + w > sw + 20 or y + h > sh + 20
            if need:
                win32gui.SetWindowPos(hwnd, win32con.HWND_TOP, 40, 20, tw, th, win32con.SWP_SHOWWINDOW)
                log("微信窗口调整：%dx%d @(%d,%d) → %dx%d（保证自动发送稳定）" % (w, h, x, y, tw, th))
                time.sleep(0.8)
        except Exception as e:
            log_window_problem("调整微信窗口失败（继续发送）", e)

    def force_send_foreground(fn):
        """把微信拉到前台再发送（真正的兜底路径）。

        注意：实测下来大多数时候**不需要**这条路 —— 微信最小化、被别的窗口挡住、
        甚至前台是全屏程序时，UIA 都能正常发送（见 docs/接入微信.md 的实测数据）。
        所以它只作为「后台发送失败后」的第二次尝试。
        """
        hwnd = int(ACCOUNT.get("hwnd") or 0) or find_weixin_hwnd()
        was_topmost = False
        touched = False
        try:
            import win32gui
            import win32con
            if hwnd:
                try:
                    if not win32gui.IsWindowVisible(hwnd):
                        # 微信在托盘里时主窗是隐藏的，先把窗口拉出来再打字
                        win32gui.ShowWindow(hwnd, win32con.SW_SHOW)
                        win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
                        log("微信在托盘里，已把主窗口拉出来再发送")
                        time.sleep(0.4)
                except Exception as e:
                    log("拉出微信窗口失败：", repr(e))
                normalize_window(hwnd)
                try:
                    fg = win32gui.GetForegroundWindow()
                except Exception:
                    fg = 0
                if fg != hwnd:
                    touched = True
                    force_foreground(hwnd)
                    ex = win32gui.GetWindowLong(hwnd, win32con.GWL_EXSTYLE)
                    was_topmost = bool(ex & win32con.WS_EX_TOPMOST)
                    # 置顶失败不该让整条发送失败（比如挑到了不能定位的窗口），
                    # 顶多是“可能被别的窗口挡住”，打字还有 UIA 兜着
                    try:
                        win32gui.SetWindowPos(
                            hwnd, win32con.HWND_TOPMOST, 0, 0, 0, 0,
                            win32con.SWP_NOMOVE | win32con.SWP_NOSIZE,
                        )
                    except Exception as e:
                        log_window_problem("窗口置顶失败（继续发送）", e)
                    win32gui.ShowWindow(hwnd, win32con.SW_RESTORE)
                    time.sleep(0.2)
            return fn()
        finally:
            try:
                if touched and hwnd and not was_topmost:
                    import win32gui
                    import win32con
                    win32gui.SetWindowPos(
                        hwnd, win32con.HWND_NOTOPMOST, 0, 0, 0, 0,
                        win32con.SWP_NOMOVE | win32con.SWP_NOSIZE,
                    )
            except Exception:
                pass

    def with_window_on_top(fn):
        """发送前确保能发出去。

        默认**不长期占用前台**（backgroundSend=true）：
          1. 先直接让 UIA 在后台发（微信最小化/被遮挡也能发，实测 18/18）；
          2. 万一失败，才把微信拉到前台重试一次；
          3. 不管成功失败，**发完都把窗口状态还原**（该最小化的重新最小化、前台还给原来的窗口），
             这样你在用电脑时最多看到它闪一下。
        把 wechat.backgroundSend 设成 false 就退回以前的「每次先抢前台、发完不管」。
        """
        if game_running():
            return False
        SEND_STATE["active"] = True
        SEND_STATE["start"] = time.time()
        snap = snapshot_win_state() if BACKGROUND_SEND else None
        try:
            if BACKGROUND_SEND:
                try:
                    if fn():
                        return True
                except Exception as e:                 # noqa: BLE001
                    log("后台发送异常，改走前台重试：", repr(e))
                log("后台发送没成功，把微信拉到前台再试一次")
                return force_send_foreground(fn)
            return force_send_foreground(fn)
        finally:
            if BACKGROUND_SEND:
                restore_win_state(snap)
            SEND_STATE["active"] = False

    def force_foreground(hwnd):
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
                # 前台锁最常见：先按一下 ALT，把「前台占用」释放掉
                win32api.keybd_event(win32con.VK_MENU, 0, 0, 0)
                win32api.keybd_event(win32con.VK_MENU, 0, win32con.KEYEVENTF_KEYUP, 0)
                time.sleep(0.05)
                try:
                    user32.SwitchToThisWindow(hwnd, True)
                except Exception:
                    pass
                time.sleep(0.15)
                if win32gui.GetForegroundWindow() == hwnd:
                    return True
            except Exception:
                pass
            time.sleep(0.15)
        try:
            return win32gui.GetForegroundWindow() == hwnd
        except Exception:
            return False

    UIA_CACHE = {"u": None}

    def _input_value(u):
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

    def press_enter(with_ctrl=False):
        """用底层按键补发 Enter（UIA 的 SendKeys 有时不触发发送）。"""
        try:
            import win32api
            import win32con
            hwnd = int(ACCOUNT.get("hwnd") or 0) or find_weixin_hwnd()
            if hwnd:
                force_foreground(hwnd)
            time.sleep(0.10)
            if with_ctrl:
                win32api.keybd_event(0x11, 0, 0, 0)
            win32api.keybd_event(0x0D, 0, 0, 0)
            win32api.keybd_event(0x0D, 0, win32con.KEYEVENTF_KEYUP, 0)
            if with_ctrl:
                win32api.keybd_event(0x11, 0, win32con.KEYEVENTF_KEYUP, 0)
            time.sleep(0.25)
            return True
        except Exception as e:
            log("手动回车失败：", repr(e))
            return False

    def snapshot_win_state():
        """记下发送前的「窗口长什么样」，发完要还原。

        要还原的东西：微信是不是最小化、原来哪个窗口在前台。
        """
        snap = {"hwnd": 0, "iconic": False, "fg": 0}
        try:
            import win32gui
            snap["hwnd"] = int(ACCOUNT.get("hwnd") or 0) or find_weixin_hwnd() or 0
            if snap["hwnd"]:
                snap["iconic"] = bool(win32gui.IsIconic(snap["hwnd"]))
            snap["fg"] = win32gui.GetForegroundWindow() or 0
        except Exception:
            pass
        return snap

    def restore_win_state(snap):
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
            wx = snap.get("hwnd")
            if wx and snap.get("iconic"):
                try:
                    win32gui.ShowWindow(wx, win32con.SW_MINIMIZE)
                except Exception:
                    pass
                time.sleep(0.12)
            fg = snap.get("fg")
            if not fg or fg == wx or not win32gui.IsWindow(fg):
                return
            for attempt in range(3):
                try:
                    # 先按一下 ALT 解锁前台锁（单独 SetForegroundWindow 会被拒绝）
                    win32api.keybd_event(win32con.VK_MENU, 0, 0, 0)
                    win32api.keybd_event(win32con.VK_MENU, 0, win32con.KEYEVENTF_KEYUP, 0)
                    time.sleep(0.04)
                    ctypes.windll.user32.SetForegroundWindow(fg)
                except Exception:
                    pass
                time.sleep(0.12)
                if ctypes.windll.user32.GetForegroundWindow() == fg:
                    return
                # 兜底：SwitchToThisWindow 不受前台锁限制（老 API，但有效）
                try:
                    ctypes.windll.user32.SwitchToThisWindow(fg, True)
                except Exception:
                    pass
                time.sleep(0.12)
                if ctypes.windll.user32.GetForegroundWindow() == fg:
                    return
            log_window_problem("还原前台失败（窗口已最小化，不影响使用）", None)
        except Exception as e:                      # noqa: BLE001
            log_window_problem("还原窗口状态失败", e)

    def install_quiet_uia(u):
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
            if getattr(u, "_whale_quiet_patch", False):
                u.quiet_mode = True
                return
            orig = u._activate

            def patched(self, win, _orig=orig):
                if getattr(self, "quiet_mode", False):
                    return
                return _orig(win)

            u._activate = types.MethodType(patched, u)
            u._whale_quiet_patch = True
            u.quiet_mode = True
        except Exception as e:                      # noqa: BLE001
            log("后台模式补丁没打上（不影响发送）：", repr(e))

    # ---------------------------------------------------------------- 零焦点通道
    BG_STATS = {"tried": 0, "ok": 0, "last": "", "lastAt": 0.0,
                "disabled": False, "treeFails": 0, "cooldownUntil": 0.0}

    def _bg_hwnd():
        try:
            return int(ACCOUNT.get("hwnd") or 0) or find_weixin_hwnd()
        except Exception:
            return 0

    def bg_send(text, chat_display_name, chat_username=""):
        """零焦点通道：用窗口消息打字 + 点发送，全程不抢前台。

        见 `bridge/bg_sender.py` 与 `docs/微信消息后台发送.md`。失败返回 False，
        由 send_text 继续走 UIA / 键盘 / OCR。**不动 gui、不碰 win32gui**，
        所以即使 wechatauto 的 UIA 引擎挂了这条也能用。
        """
        if not BG_SEND.get("enabled", True) or BG_STATS["disabled"]:
            return False
        # 树连续起不来（多半是微信版本不支持）就先歇 10 分钟，
        # 免得每条消息都白等 2 秒的物化时间。
        if time.time() < BG_STATS["cooldownUntil"]:
            return False
        try:
            import bg_sender
        except Exception:
            try:
                from . import bg_sender          # type: ignore
            except Exception as e:               # noqa: BLE001
                BG_STATS["disabled"] = True
                log("后台通道：模块导入失败，本次运行内关闭这条通道：", repr(e))
                return False

        hwnd = _bg_hwnd()
        if not hwnd:
            return False
        if chat_username:
            keys = aliases_for(chat_username, chat_display_name) or [chat_display_name]
        else:
            keys = [chat_display_name]

        t0 = time.time()
        try:
            ok, why = bg_sender.send(
                text,
                chat=keys,
                hwnd=hwnd,
                log=log,
                char_gap=BG_SEND.get("charGap", 0.04),
                strip_unencodable=BG_SEND.get("strip", True),
                verify=BG_SEND.get("verify", True),
                unhide=BG_SEND.get("unhide", True),
            )
        except Exception as e:                   # noqa: BLE001
            ok, why = False, "exception:" + type(e).__name__
            log("后台通道异常：", repr(e))

        BG_STATS["tried"] += 1
        BG_STATS["last"] = why
        BG_STATS["lastAt"] = time.time()
        if ok:
            BG_STATS["ok"] += 1
            BG_STATS["treeFails"] = 0
            log("后台通道发送成功（%s，%.1fs）" % (why, time.time() - t0))
            return True

        log("后台通道没发出去（%s，%.1fs），换下一条通道：%s"
            % (why, time.time() - t0, chat_display_name))

        if why == "tree_not_ready":
            BG_STATS["treeFails"] += 1
            if BG_STATS["treeFails"] >= 3:
                BG_STATS["cooldownUntil"] = time.time() + 600
                BG_STATS["treeFails"] = 0
                log_throttled(
                    "bg-tree-cooldown",
                    "后台通道连续 3 次读不到控件树，先停 10 分钟再试"
                    "（其余通道不受影响）。排查：python -m bridge --bg-probe",
                )

        # 这几类是「环境问题」，报一次就够，别每条消息刷屏
        if why == "uipi_denied":
            log_throttled(
                "bg-uipi",
                "后台通道被 UIPI 拒绝：微信是管理员权限、桥接不是。"
                "把两边权限调成一样（都用管理员，或都不用）即可。",
            )
        elif why == "minimized":
            log_throttled(
                "bg-min",
                "微信最小化了：零焦点通道要求窗口显示出来"
                "（用「显示但不激活」拉出来，不抢前台）。",
            )
        elif why == "tree_not_ready":
            log_throttled(
                "bg-tree",
                "后台通道读不到控件树：确认微信没缩在托盘；"
                "4.2 需要 wechatauto 的 gate 热激活，必要时提权重试。"
                "诊断：python -m bridge --bg-probe",
            )
        elif why == "chat_not_found" and chat_username:
            # 会话列表只有最近十来个，老会话得靠前台通道搜索；这种情况不吵
            log("后台通道：%s 不在会话列表里，改用会搜索的通道" % chat_display_name)
        return False

    def uia_send(text, who, username=""):
        """优先用 UIA 发送：不依赖 OCR 找发送按钮，成功后返回 True。"""
        # 账号闸：先确认「要打字的这个窗口」就是配置指定的那个号，窗口换了就重认
        if not account_send_allowed("UIA"):
            return False
        if not wechat_window_alive():
            # 主窗没了，缓存引擎里的句柄已失效，碰了会 0xC0000005；直接走键盘/OCR 兜底
            with gui_lock:
                UIA_CACHE["u"] = None
            return False
        u = UIA_CACHE["u"]
        # 每次发送都问一次库里的引擎（它内部 30 秒节流、会自己检测「子控件不可见」并重新热激活）。
        # 以前只在缓存为空时才问，结果微信把 accessibility gate byte 归零后，缓存的引擎变成
        # 「假死」：能收消息、但一条也发不出去，挂着挂着就不理人了，只能重启桥接才好。
        try:
            with gui_lock:
                fresh = gui._get_uia() if gui is not None else None
            if fresh is not None:
                u = fresh
            UIA_CACHE["u"] = u
        except Exception:
            u = UIA_CACHE["u"]
        if u is None:
            return False
        if BACKGROUND_SEND:
            # 后台模式：禁止引擎自己恢复窗口/抢前台（真正的抢前台只在兜底那一步做）
            install_quiet_uia(u)
        keys = aliases_for(username, who) if username else [who]
        try:
            cur = None
            try:
                cur = u.current_chat()
            except Exception:
                pass
            hit_cur = (cur == who) or any(cur == k for k in keys if k)
            if not hit_cur and username:
                hit_cur = bool(cur) and open_cache.get(username) == cur
            if not hit_cur:
                if not u.open_chat(keys):
                    try:
                        u.back_to_chat_tab()
                    except Exception:
                        pass
                    if not u.open_chat(keys):
                        return False
                if username:
                    try:
                        open_cache[username] = u.current_chat() or ""
                        log("UIA 已切到会话：", open_cache[username])
                    except Exception:
                        pass
            t_open = time.time()
            sent_ok = False
            try:
                sent_ok = bool(u.send_text(text))
            except Exception:
                sent_ok = False
            if not sent_ok:
                try:
                    u.back_to_chat_tab()
                    sent_ok = bool(u.send_text(text))
                except Exception:
                    sent_ok = False
            log("UIA 发送耗时 %.1fs（打开会话+输入）" % (time.time() - t_open))
            if sent_ok:
                # 多按几次：Enter 两次 + Ctrl+Enter 两次（兼容“按 Ctrl+Enter 发送”的设置）
                press_enter(False)
                press_enter(False)
                press_enter(True)
                press_enter(True)
                return True
        except Exception as e:
            log("UIA 发送异常：", repr(e))
        return False

    def recover_uia(reason=""):
        """强制重新热激活 UIA（rewrite gate byte + 校验），成功返回 True。

        微信跑久了会把 accessibility gate byte 归零，UIA 引擎就变成「假死」：
        能读消息、发不出去。以前只能重启桥接；这里让它自己救回来。
        """
        try:
            if gui is None:
                return False
            if not wechat_window_alive():
                with gui_lock:
                    UIA_CACHE["u"] = None
                log("UIA 重新热激活跳过（微信主窗当前不存在）")
                return False
            with gui_lock:
                u = gui._get_uia(refresh=True)
            UIA_CACHE["u"] = u
            if u is not None:
                log("UIA 已重新热激活%s" % (("（" + reason + "）") if reason else ""))
                return True
            log("UIA 重新热激活失败%s" % (("（" + reason + "）") if reason else ""))
        except Exception as e:                     # noqa: BLE001
            log("UIA 重新热激活异常：", repr(e))
        return False

    def keyboard_send(text, chat_display_name, chat_username=""):
        """完全不依赖 UIA 的发送通道：Ctrl+F 搜索会话 → 粘贴 → 回车 → 回读数据库确认。

        为什么需要它：UIA 依赖微信的 accessibility gate，微信跑久了/窗口状态怪的时候
        整条路都会挂（见 recover_uia 的注释）。键盘通道只用 Win32 按键 + 剪贴板，
        走的是微信自己的搜索框，不碰 accessibility。
        代价：会抢前台、慢一些，所以只在 UIA 真的发不出去时用。
        """
        # 账号闸：键盘通道是在「当前前台窗口」里按 Ctrl+F 搜会话的，
        # 不先钉住目标号的话，搜索会落在另一个账号的微信窗口里。
        if not account_send_allowed("键盘通道"):
            return False
        try:
            import ctypes
            import win32api          # noqa: F401
            import win32clipboard
            import win32con
            import win32gui
            user32 = ctypes.windll.user32
        except Exception as e:                     # noqa: BLE001
            log("键盘通道不可用（缺少 win32 模块）：", repr(e))
            return False

        hwnd = int(ACCOUNT.get("hwnd") or 0) or find_weixin_hwnd()
        if not hwnd:
            log("键盘通道：找不到微信主窗")
            return False

        def fg():
            return user32.GetForegroundWindow()

        # 抢前台：单独 SetForegroundWindow 会被前台锁拒绝，先按一下 ALT 解锁
        if fg() != hwnd:
            user32.keybd_event(win32con.VK_MENU, 0, 0, 0)
            time.sleep(0.05)
            user32.SetForegroundWindow(hwnd)
            time.sleep(0.2)
            user32.keybd_event(win32con.VK_MENU, 0, 2, 0)
            time.sleep(0.2)
        if fg() != hwnd:
            try:
                user32.SwitchToThisWindow(hwnd, True)
                time.sleep(0.3)
            except Exception:
                pass
        if fg() != hwnd:
            log("键盘通道：抢不到前台，放弃这次（UIA 也不可用时这条就发不出去了）")
            return False

        def set_clip(t):
            for _ in range(5):
                try:
                    win32clipboard.OpenClipboard()
                    break
                except Exception:                  # noqa: BLE001
                    time.sleep(0.1)
            try:
                win32clipboard.EmptyClipboard()
                win32clipboard.SetClipboardData(win32clipboard.CF_UNICODETEXT, t)
            finally:
                win32clipboard.CloseClipboard()

        def tap(vk, mods=()):
            for m in mods:
                user32.keybd_event(m, 0, 0, 0)
            user32.keybd_event(vk, 0, 0, 0)
            user32.keybd_event(vk, 0, 2, 0)
            for m in reversed(mods):
                user32.keybd_event(m, 0, 2, 0)
            time.sleep(0.12)

        def confirmed_target():
            """打开会话后确认「现在开着的到底是谁」。

            键盘通道是模拟按键，搜不到人时回车会落到「当前那个会话」上，
            正文就直接发给别人了 —— 2026-10-25 12:21 的日志里就出现过
            「键盘通道：按键发了，但数据库里没确认到（可能发到了别的会话）」。
            这里用 UIA 的只读能力核对（读会话名在「能读不能发」的假死状态下依然可用）；
            读不到就宁可这条失败，也不盲发 —— 私聊内容发错人比晚回一条严重得多。
            返回 (是否匹配, 当前会话名)。
            """
            try:
                u = gui._get_uia() if gui is not None else None
                cur = u.current_chat() if u is not None else None
            except Exception:
                cur = None
            if not cur:
                return None, None
            cands = {chat_display_name}
            try:
                if chat_username:
                    cands.update(aliases_for(chat_username, chat_display_name))
                    cached = open_cache.get(chat_username)
                    if cached:
                        cands.add(cached)
            except Exception:
                pass
            return (cur in cands), cur

        try:
            # ① 搜索会话（微信的 Ctrl+F）
            tap(ord("F"), (win32con.VK_CONTROL,))
            time.sleep(0.5)
            set_clip(chat_display_name)
            tap(ord("V"), (win32con.VK_CONTROL,))
            time.sleep(0.8)
            tap(win32con.VK_RETURN)          # ② 打开会话
            time.sleep(0.9)
            # ②.5 先核对打开的是不是目标会话，确认不了就不往输入框里打字
            matched, cur = confirmed_target()
            if matched is None:
                log("键盘通道：读不到当前会话名，为防发错人这次不发")
                return False
            if not matched:
                log("键盘通道：打开的是「%s」而不是「%s」，为防发错人这次不发"
                    % (cur or "", chat_display_name))
                return False
            set_clip(text)                    # ③ 粘贴正文
            tap(ord("V"), (win32con.VK_CONTROL,))
            time.sleep(0.4)
            tap(win32con.VK_RETURN)          # ④ 发送
        except Exception as e:                 # noqa: BLE001
            log("键盘通道按键失败：", repr(e))
            return False

        # ⑤ 回读数据库确认这条真的发出去了（搜错会话时能立刻发现）
        for _ in range(8):
            time.sleep(0.5)
            try:
                msgs = db.get_messages(chat_username or chat_display_name, limit=3) or []
            except Exception:
                msgs = []
            for m in msgs:
                if str(m.get("content") or "").strip()[:12] == str(text).strip()[:12]:
                    return True
        log("键盘通道：按键发了，但数据库里没确认到（可能发到了别的会话），这条按失败处理")
        return False

    # Protected by send_lock. Feature OFF must not erase a latent attachment
    # draft: this guard protects ordinary text/@ sends too, without sending keys.
    sticker_draft_quarantine = {}

    def sticker_quarantine_allows(username, shown="", gui_locked=False):
        requested = str(username or "").strip()
        matches = [(key, entry) for key, entry in sticker_draft_quarantine.items()
                   if key == requested or (not requested and
                       (str(shown or "").strip() == key or str(shown or "").strip() in entry["aliases"]))]
        if not matches:
            return True

        def inspect():
            for key, entry in matches:
                value = None
                try:
                    compat = _compat_mod()
                    if (ACCOUNT.get("verified") and int(ACCOUNT.get("hwnd") or 0) == entry["hwnd"]
                            and compat is not None and int(compat.pinned_window() or 0) == entry["hwnd"]
                            and wechat_window_alive()):
                        value = quarantined_input_value(gui, entry["hwnd"], entry["aliases"])
                except Exception:
                    pass
                if isinstance(value, str) and not sticker_input_is_blank(value):
                    entry["draft_observed"] = True
                if sticker_input_is_blank(value) and entry["draft_observed"]:
                    sticker_draft_quarantine.pop(key, None)
                else:
                    return False
            return True

        if gui_locked:
            allowed = inspect()
        else:
            with gui_lock:
                allowed = inspect()
        if not allowed:
            log_throttled("uncertain-attachment-draft", "发送暂停：上次附件操作可能留有草稿；请手动清空目标输入框后重试。"
                          "无法读取清空证据时，请手动清空后重启桥接。", ttl=60)
        return allowed

    def wechat_main_window_count():
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
        except Exception:                     # noqa: BLE001
            return None
        count = 0
        for h in hwnds:
            try:
                cls = win32gui.GetClassName(int(h)) or ""
                title = (win32gui.GetWindowText(int(h)) or "").strip()
            except Exception:                 # noqa: BLE001
                continue
            if ("QWindowIcon" in cls or "mmui::" in cls) and title == "微信":
                count += 1
        return count

    def sticker_account_evidence_allowed():
        # 只有一个可见微信窗口时，文字消息一直是认的；表情包以前额外要求
        # 「手动钉窗口」，结果多开过的机器全都发不出去（日志里就是
        # 「failed target account window could not be verified」）。
        # 现在和文字用同一套证据：本机只登着一个微信（一个主窗）就放行；
        # 真·多开时才要求网页里明确选账号、且数据库就是用这个号打开的。
        explicit_pin = bool(WINDOW_HWND and int(WINDOW_HWND) == int(ACCOUNT.get("hwnd") or 0))
        allowed = sticker_account_evidence_ok(
            configured_account=ACCOUNT_WANTED,
            db_account=getattr(db, "account", ""),
            reason=ACCOUNT.get("why"),
            explicit_pin=explicit_pin,
            account_dirs=acct_dirs,
            visible_windows=wechat_main_window_count(),
        )
        if not allowed:
            log_throttled(
                "sticker-account-ambiguous",
                "表情包跳过：当前微信窗口和账号信息不一致，或多个窗口无法区分。"
                "只登录一个号且数据库匹配时无需手选；多开时请在设置中选账号。",
                ttl=300,
            )
        return allowed

    sticker_headers = {"x-bot-token": token, "x-whale-bridge": "1"}
    sticker_base = bot_url.rsplit("/webhook", 1)[0]

    def sticker_config_now():
        # Dormant worker does no sticker HTTP/path/GUI work while the cached flag
        # is off. Only config_watch re-enables it; an on flag is NEVER authority
        # to act without a fresh disk read.
        global STICKER_TEST_ON
        if not STICKER_TEST_ON:
            return None
        current = read_enabled_config(CONFIG_PATH)
        if current is None:
            STICKER_TEST_ON = False
            return None
        # A pending account change must not send through the old DB/window while
        # config_watch is still waiting to restart the bridge.
        if str((current.get("wechat") or {}).get("account") or "").strip() != ACCOUNT_WANTED:
            return None
        return current

    def sticker_gate(generation, job_id=""):
        if not generation or sticker_config_now() is None:
            return False
        try:
            response = LOCAL_HTTP.get(sticker_base + "/api/stickers/status",
                                      headers=sticker_headers, timeout=3)
            status = response.json() if response.status_code == 200 else None
            return bool(isinstance(status, dict) and status.get("ok") is True
                        and status.get("enabled") is True
                        and status.get("generation") == generation
                        and (not job_id or any(isinstance(job, dict) and job.get("id") == job_id
                                               and job.get("status") == "sending"
                                               and job.get("generation", generation) == generation
                                               for job in (status.get("jobs") or [])))
                        and sticker_config_now() is not None)
        except Exception:
            return False

    def sticker_activity_allowed(username=""):
        try:
            return not (AWAY["on"] or away_active() or game_running() or foreground_is_fullscreen()
                        or (username and (username in dead_chats or not group_is_alive(username))))
        except Exception:
            return False

    def send_sticker(path, chat_display_name, chat_username="", generation="", job_id=""):
        """一次性、无导航的图片粘贴；只能向已在前台打开且聚焦的精确会话发送。"""
        if not job_id or not sticker_gate(generation, job_id):
            return sticker_result("cancelled", "stickers are disabled or generation expired")
        with send_lock:
            if not sticker_gate(generation, job_id):
                return sticker_result("cancelled", "stickers are disabled or generation expired")
            if not sticker_quarantine_allows(chat_username, chat_display_name):
                return sticker_result("failed", "an uncertain attachment draft must be cleared manually before further sends")
            if not sticker_activity_allowed(chat_username):
                return sticker_result("failed", "activity gate rejected the sticker")
            if (not account_send_allowed("表情包") or not ACCOUNT.get("verified")
                    or not wechat_window_alive() or not sticker_account_evidence_allowed()):
                return sticker_result("failed", "target account window could not be verified")
            hwnd = int(ACCOUNT.get("hwnd") or 0)
            snap = None
            try:
                desktop = WindowsDesktop()
                if not desktop.foreground(hwnd):
                    # 以前这里是「微信不在前台就不发」，结果用户点完发送还得自己去切窗口，
                    # 实际表现就是「表情包发不出去」。文字发送本来就是先抬一下微信、发完还原；
                    # 这里做同样的事：短暂抬到前台，粘贴前仍会重新校验会话标题/焦点/空输入框。
                    snap = snapshot_win_state()
                    if not force_foreground(hwnd) or not desktop.foreground(hwnd):
                        return sticker_result("failed", "could not bring the WeChat window to the foreground")
                    log_throttled("sticker-foreground", "表情包：微信不在前台，先切过去（发完会把窗口还原）", ttl=120)
            except Exception:
                return sticker_result("failed", "foreground safety checks are unavailable")
            try:
              with gui_lock:
                # Do not initialize/activate any window just to send a sticker.
                current_gui = gui
                if current_gui is None:
                    return sticker_result("failed", "window driver is not ready")
                if not sticker_gate(generation, job_id):
                    return sticker_result("cancelled", "stickers are disabled or generation expired")
                try:
                    canonical, aliases = resolve_sticker_target(db, chat_display_name, chat_username)
                    if not sticker_quarantine_allows(canonical, chat_display_name, gui_locked=True):
                        return sticker_result("failed", "an uncertain attachment draft must be cleared manually before further sends")
                    if not sticker_activity_allowed(canonical):
                        return sticker_result("failed", "target or activity gate rejected the sticker")
                    # Unlike bind_gui_window(), failure must not be silently ignored.
                    if not sticker_gate(generation, job_id) or not desktop.foreground(hwnd):
                        return sticker_result("cancelled", "send gates changed before binding")
                    if not current_gui.use_window(hwnd) or int(current_gui.main_hwnd) != hwnd:
                        return sticker_result("failed", "unable to bind the verified account window")
                    uia = getattr(current_gui, "_uia", None)
                    if uia is None:
                        return sticker_result("failed", "UIA target proof is unavailable; no OCR fallback")
                    # 目标会话没打开就自己切过去（和文字发送一样用 UIA 打开），
                    # 打开之后必须核对标题确实是目标，否则宁可不发。
                    # 搜索顺序：先显示名，再其它别名（昵称/备注/wxid）。
                    search_keys = [chat_display_name] + [a for a in aliases if a and a != chat_display_name]
                    try:
                        if not sticker_alias_match(uia.current_chat(), aliases):
                            uia.open_chat(search_keys)
                            # 切换会话有时要 1 秒左右才稳定，最多等 2 秒
                            for _ in range(8):
                                time.sleep(0.25)
                                if sticker_alias_match(uia.current_chat(), aliases):
                                    break
                    except Exception:
                        return sticker_result("failed", "exact target is not open in the pinned window")
                    if not sticker_alias_match(uia.current_chat(), aliases):
                        return sticker_result("failed", "exact target is not open in the pinned window")
                    current = sticker_config_now()
                    if current is None:
                        return sticker_result("cancelled", "stickers are disabled")
                    directory = (current.get("sticker") or {}).get("dir") or "data/stickers"
                    directory = directory if os.path.isabs(directory) else os.path.join(ROOT, directory)

                    def pinned_account_valid():
                        try:
                            compat = _compat_mod()
                            return bool(ACCOUNT.get("verified") and int(ACCOUNT.get("hwnd") or 0) == hwnd
                                        and sticker_account_evidence_allowed()
                                        and wechat_window_alive() and compat is not None
                                        and int(compat.pinned_window() or 0) == hwnd)
                        except Exception:
                            return False

                    def transaction_gate():
                        if not sticker_gate(generation, job_id):
                            return False
                        latest = sticker_config_now()
                        if latest is None:
                            return False
                        latest_dir = (latest.get("sticker") or {}).get("dir") or "data/stickers"
                        latest_dir = latest_dir if os.path.isabs(latest_dir) else os.path.join(ROOT, latest_dir)
                        wanted_hwnd = int((latest.get("wechat") or {}).get("windowHwnd") or 0)
                        return (os.path.normcase(os.path.abspath(latest_dir)) == os.path.normcase(os.path.abspath(directory))
                                and wanted_hwnd in (0, hwnd))

                    SEND_STATE["active"] = True
                    SEND_STATE["start"] = time.time()
                    try:
                        outcome = guarded_sticker_send(
                            current_gui, uia, hwnd, aliases, path, directory, db, canonical,
                            gate=transaction_gate, account_valid=pinned_account_valid,
                            activity_allowed=lambda: sticker_activity_allowed(canonical), desktop=desktop)
                        if not isinstance(outcome, dict) or outcome.get("status") not in {
                                "confirmed", "unconfirmed", "failed", "cancelled"}:
                            raise ValueError("unknown attachment result")
                    except Exception:
                        outcome = sticker_result("unconfirmed", "transport action is uncertain; a draft may remain; do not retry",
                                                 draft_may_remain=True)
                    finally:
                        SEND_STATE["active"] = False
                    if outcome.get("draft_may_remain") or outcome.get("status") == "unconfirmed":
                        sticker_draft_quarantine[canonical] = {
                            "hwnd": hwnd, "aliases": aliases,
                            "draft_observed": bool(outcome.get("draft_observed"))}
                    return outcome
                except Exception:
                    return sticker_result("failed", "sticker safety checks are unavailable")
            finally:
                if snap:
                    try:
                        restore_win_state(snap)
                    except Exception:
                        pass

    def claim_and_send_sticker(item, expected_chat="", expected_username=""):
        """Atomic claim precedes every send, including normal webhook stickers.

        Never send from an unclaimed payload, never retry a claim or attachment,
        and never interpret a truthy result dictionary as confirmed delivery.
        """
        if not isinstance(item, dict) or not sticker_gate(item.get("generation")):
            return sticker_result("cancelled", "stickers are disabled or generation expired")
        job_id = str(item.get("id") or "")
        if not job_id:
            return sticker_result("failed", "sticker job id is missing")
        try:
            response = LOCAL_HTTP.post(sticker_base + "/api/stickers/claim", json={"id": job_id},
                                       headers=sticker_headers, timeout=3)
            claimed = response.json() if response.status_code == 200 else None
            claimed = claimed.get("item") if isinstance(claimed, dict) and claimed.get("ok") is True else None
        except Exception:
            claimed = None
        if not isinstance(claimed, dict):
            return sticker_result("failed", "sticker job was not claimed; nothing was sent")
        if (claimed.get("id") != job_id or claimed.get("generation") != item.get("generation")
                or claimed.get("status") != "sending"
                or (expected_chat and not expected_username and claimed.get("chat") != expected_chat)
                or (expected_username and claimed.get("chatUsername") != expected_username)):
            outcome = sticker_result("failed", "claimed job identity did not match the request")
        else:
            outcome = send_sticker(claimed.get("path"), claimed.get("chat") or "",
                                   claimed.get("chatUsername") or "", claimed.get("generation"), job_id)
        # Off means no sticker requests/logs, including acknowledgements. The
        # server cancels/ages its claimed jobs; loss of ack NEVER causes a resend.
        if sticker_gate(item.get("generation")):
            # 结果必须写回服务端，否则控制台会一直显示「尝试发送中」。
            # 服务端是单线程 Node：正好在生成长回复时，3 秒超时会有概率失败，
            # 以前这里 except: pass 把它吞了，于是界面永远停在 sending。
            payload = {"id": job_id, "status": outcome["status"], "error": outcome["error"]}
            for attempt in range(3):
                try:
                    resp = LOCAL_HTTP.post(sticker_base + "/api/stickers/ack", json=payload,
                                           headers=sticker_headers, timeout=8)
                    if getattr(resp, "status_code", 0) in (200, 404, 409):
                        break
                except Exception as exc:
                    if attempt == 2:
                        log_throttled("sticker-ack-fail",
                                      "表情包结果没能写回服务端（不影响已经发出的消息）：" + repr(exc),
                                      ttl=300)
                time.sleep(0.4)
            if sticker_config_now() is not None:
                log("表情包结果：", outcome["status"], outcome["error"])
        return outcome

    def send_text(text, chat_display_name, chat_username="", force=False, quote_text=None):
        nonlocal gui
        if chat_username and chat_username in dead_chats:
            log("跳过已失效的会话：", chat_display_name)
            return False
        if chat_username and not group_is_alive(chat_username):
            dead_chats.add(chat_username)
            log("群里已经没有我了（被移出？），以后跳过：", chat_display_name)
            return False
        if not force and (AWAY["on"] or away_active() or game_running() or foreground_is_fullscreen()):
            with pending_lock:
                pending_replies[chat_username or chat_display_name] = (text, chat_display_name, chat_username, time.time())
            log("你在游戏/全屏程序里，回复先排队，等你退出再发：", chat_display_name)
            return True
        # 账号闸：认不出「哪个窗口是小号」就不发（放在排队判断之后，免得游戏里直接丢消息）
        if not account_send_allowed("发送"):
            return False
        with send_lock:
            if not sticker_quarantine_allows(chat_username, chat_display_name):
                return False
            if not force and (AWAY["on"] or away_active() or game_running() or foreground_is_fullscreen()):
                with pending_lock:
                    pending_replies[chat_username or chat_display_name] = (text, chat_display_name, chat_username, time.time())
                log("游戏/全屏中，先排队：", chat_display_name)
                return True
            # ⓪ 零焦点通道：不依赖 WeChatGUI（构造它本身就会抢一次焦点），先试这条。
            #    见 bridge/bg_sender.py 与 docs/微信消息后台发送.md。
            #    失败才往下走会动窗口的旧通道。
            t_start = time.time()
            allow_mark_dead = True
            if BG_SEND.get("enabled", True):
                SEND_STATE["active"] = True
                SEND_STATE["start"] = time.time()
                try:
                    if bg_send(text, chat_display_name, chat_username):
                        fail_streak.pop(chat_username, None)
                        log("发送成功（后台通道，%.1fs）→ %s"
                            % (time.time() - t_start, chat_display_name))
                        return True
                except Exception as e:            # noqa: BLE001
                    log("后台通道异常，继续用旧通道：", repr(e))
                finally:
                    SEND_STATE["active"] = False
                if not BG_SEND.get("fallback", True):
                    # 用户明确要求「绝不抢前台」：这条不发，但不把会话标死
                    # （窗口最小化、会话不在列表里都是可恢复状态）。
                    allow_mark_dead = False
                    log("后台通道失败且已关闭前台兜底，这条不发：", chat_display_name)
                    return False

            with gui_lock:
                if gui is None:
                    log("初始化微信窗口驱动…（会抢一下焦点，约 5~10 秒）")
                    gui = WeChatGUI()
            # 多账号：GUI 的坐标/OCR 目标也要对齐到钉住的账号窗口
            bind_gui_window(gui)
            # ① 引用回复（引用对方那条消息）——比普通发送慢，失败自动回退
            if quote_text and QUOTE_REPLY:
                try:
                    if with_window_on_top(lambda: gui.quote_msg(text, who=chat_display_name, target_text=quote_text, verify=False)):
                        log("引用回复成功 →", chat_display_name)
                        return True
                except Exception as e:
                    log("引用回复失败，回退普通发送：", repr(e))
            # ①.5 首选 UIA：稳定、快，不依赖 OCR 找发送按钮
            uia_available = False
            try:
                uia_available = gui._get_uia() is not None
            except Exception:
                uia_available = False
            for attempt in (1, 2):
                t_att = time.time()
                try:
                    if with_window_on_top(lambda: uia_send(text, chat_display_name, chat_username)):
                        fail_streak.pop(chat_username, None)
                        log("发送成功（%.1fs）→ %s" % (time.time() - t_start, chat_display_name))
                        return True
                    log("UIA 发送未成功（第 %d 次，%.1fs），准备重试" % (attempt, time.time() - t_att))
                except Exception as e:
                    log("UIA 发送异常（第 %d 次，%.1fs）：%r" % (attempt, time.time() - t_att, e))
                time.sleep(0.5)
            if uia_available:
                # UIA 报告可用却没发出去：多半是 gate byte 被归零（引擎假死）。
                # 强制重激活一次再试，别让用户只能重启桥接。
                if recover_uia("发送失败"):
                    try:
                        if with_window_on_top(lambda: uia_send(text, chat_display_name, chat_username)):
                            fail_streak.pop(chat_username, None)
                            log("重新激活 UIA 后发送成功（%.1fs）→ %s" % (time.time() - t_start, chat_display_name))
                            return True
                    except Exception as e:            # noqa: BLE001
                        log("重新激活后仍失败：", repr(e))
                log("UIA 发不出去，跳过 OCR 兜底：", chat_display_name)
            else:
                log_throttled("uia-unavailable",
                              "UIA 不可用：先试键盘通道；如果一直这样，双击「一键诊断UIA.bat」看原因"
                              "（常见：微信需要重新登录、鲸鱼娘不是管理员而微信是、微信缩在托盘）",
                              ttl=600)
                log("UIA 不可用，走 OCR 兜底")
            # ①.5 键盘兜底：完全不碰 accessibility（Ctrl+F 搜索会话 → 粘贴 → 回车），
            #      并用数据库回读确认。OCR 这条路会卡在截屏，所以先试它。
            if KEYBOARD_FALLBACK:
                if keyboard_send(text, chat_display_name, chat_username):
                    fail_streak.pop(chat_username, None)
                    log("发送成功（键盘通道，%.1fs）→ %s" % (time.time() - t_start, chat_display_name))
                    return True
            # ② 兜底：仅当 UIA 不可用时才走 OCR。
            #    注意：OCR 这条路在这台机器上会卡死在 PIL.ImageGrab.grab 截屏里
            #    （data/bridge-hang.log 有栈），以前直接拖到 40 秒看门狗把整个桥接
            #    os.exit 重启；这里给它 25 秒，超时就放弃这一条。
            if not uia_available:
                try:
                    with gui_lock:
                        try:
                            gui = WeChatGUI()
                        except Exception as e:
                            log("重建窗口驱动失败：", repr(e))
                    bind_gui_window(gui)
                    _box = {}

                    def _ocr_send():
                        try:
                            _box["r"] = with_window_on_top(
                                lambda: gui.send_msg(text, chat_display_name, True))
                        except Exception as _e:      # noqa: BLE001
                            _box["e"] = _e

                    _th = threading.Thread(target=_ocr_send, daemon=True)
                    _th.start()
                    # 8 秒足够 OCR 定位；等太久只会让用户看到「发了没反应」
                    _th.join(8)
                    if _th.is_alive():
                        log("OCR 兜底 8 秒没返回（卡在截屏），放弃这条，等下次消息")
                        resp = False
                    else:
                        if "e" in _box:
                            raise _box["e"]
                        resp = _box.get("r")
                    if bool(resp):
                        fail_streak.pop(chat_username, None)
                        return True
                    log("兜底发送失败：%s" % resp)
                except Exception as e:
                    log("兜底发送异常：%r" % e)
            if chat_username and allow_mark_dead:
                # 账号窗口认不出来导致的失败，不算「这个会话失效」——
                # 否则双开时认不出号会把这个群/好友永久标死，之后就再也不回了。
                if (time.time() - float(ACCOUNT.get("blockedAt") or 0)) < 30:
                    log("账号窗口没确认，这条不算会话失效，先不发：", chat_display_name)
                    return False
                fail_streak[chat_username] = fail_streak.get(chat_username, 0) + 1
                if fail_streak[chat_username] >= 2:
                    dead_chats.add(chat_username)
                    log("连续发送失败，先停掉这个会话：", chat_display_name)
            log("发送最终失败，请把微信窗口保持在桌面、别最小化；内容：", text[:30])
            return False

    def send_at(member, text, chat_display_name, chat_username=""):
        """在群里真 @ 某个成员（UI 选人），失败返回 False 让调用方退回普通发送。"""
        nonlocal gui
        if not member or not text:
            return False
        if chat_username and (chat_username in dead_chats or not group_is_alive(chat_username)):
            return False
        if AWAY["on"] or away_active() or game_running() or foreground_is_fullscreen():
            with pending_lock:
                pending_replies[chat_username or chat_display_name] = (text, chat_display_name, chat_username, time.time())
            log("你在游戏/全屏程序里，@ 回复先排队：", chat_display_name)
            return True
        # 账号闸：@ 人要点开成员列表，窗口不对就会在别的号里 @ 别人
        if not account_send_allowed("@ 成员"):
            return False
        with send_lock:
            if not sticker_quarantine_allows(chat_username, chat_display_name):
                return False
            with gui_lock:
                if gui is None:
                    log("初始化微信窗口驱动…（会抢一下焦点，约 5~10 秒）")
                    gui = WeChatGUI()
            bind_gui_window(gui)
            try:
                ok = bool(with_window_on_top(lambda: gui.at_member(member, text, who=chat_display_name, verify=False)))
                if ok:
                    log("已 @ %s → %s" % (member, chat_display_name))
                    return True
                log("@ 成员失败（%s），改用普通发送" % member)
            except Exception as e:
                log("@ 成员异常：", repr(e))
        return False

    def describe_image(msg):
        try:
            import base64
            user = msg.get("username") or ""
            lid = msg.get("local_id")
            shard = msg.get("shard")
            if not user or lid is None:
                return ""
            # 先用完整图（原图 > 压缩版），别拿缩略图去识别；两档都没有才退回 best
            path = None
            for _tier in ("full", "best"):
                try:
                    path = _get_media().download_image(user, int(lid), tier=_tier, shard=shard)
                except Exception as _e:
                    log("图片下载失败（tier=%s）：%r" % (_tier, _e))
                    path = None
                if path:
                    log("图片档位：%s → %d KB" % (_tier, os.path.getsize(path) // 1024))
                    break
            if not path:
                log("图片取不到本地文件")
                return ""
            with open(path, "rb") as f:
                raw = f.read()
            if len(raw) > 8 * 1024 * 1024:
                log("图片太大，跳过")
                return ""
            # 关键：按文件头判断真实格式。微信 4.x 的普通图片是 wxgf(HEVC) 容器，
            # 老代码只看扩展名，于是把 wxgf 原样当 image/jpeg 发出去，
            # 视觉接口就回「图片输入格式/解析错误」——表现就是「有时能认、有时不能」。
            if raw[:4] == b"wxgf":
                try:
                    conv = _get_media()._wxgf_to_jpg(raw)
                except Exception as _e:
                    conv = None
                    log("wxgf 转码异常：", repr(_e))
                if not conv:
                    log("这张图是 wxgf/HEVC，本机 ffmpeg 没能转出来，跳过（装 ffmpeg 到 C:\\ffmpeg 即可）")
                    return ""
                raw = conv
                ext = ".jpg"
            elif raw[:8] == b"\x89PNG\r\n\x1a\n":
                ext = ".png"
            elif raw[:3] == b"\xff\xd8\xff":
                ext = ".jpg"
            elif raw[:3] == b"GIF":
                ext = ".gif"
            else:
                ext = os.path.splitext(path)[1].lower()
                if ext not in (".jpg", ".jpeg", ".png", ".gif"):
                    log("图片格式不认识（%s），跳过" % raw[:4])
                    return ""
            mime = "image/png" if ext == ".png" else ("image/gif" if ext == ".gif" else "image/jpeg")
            base = bot_url.rsplit("/webhook", 1)[0]

            # 长截图（竖着很长）整张丢给模型，字会被缩糊；切成 2~3 段分别识别再拼起来
            parts = [raw]
            try:
                from PIL import Image
                import io as _io
                img = Image.open(_io.BytesIO(raw))
                img.load()
                w, h = img.size
                if w > 0 and h / float(w) > 2.2 and h > 1200:
                    n = 3 if h / float(w) > 4.0 else 2
                    overlap = int(h * 0.08)
                    parts = []
                    for i in range(n):
                        top = max(0, int(i * h / n) - (overlap if i else 0))
                        bottom = min(h, int((i + 1) * h / n) + overlap)
                        seg = img.crop((0, top, w, bottom)).convert("RGB")
                        buf = _io.BytesIO()
                        seg.save(buf, format="JPEG", quality=88)
                        parts.append(buf.getvalue())
                    log("长截图 %dx%d，切成 %d 段分别识别" % (w, h, len(parts)))
                else:
                    # 普通图：统一转 RGB JPEG 再发，规避 webp/heic 之类的格式坑
                    img2 = img.convert("RGB")
                    buf = _io.BytesIO()
                    img2.save(buf, format="JPEG", quality=88)
                    parts = [buf.getvalue()]
                    mime = "image/jpeg"
            except Exception as _e:
                log("图片预处理跳过（用原图）：", repr(_e))
                parts = [raw]

            texts = []
            for idx, part in enumerate(parts):
                prompt = ""
                if len(parts) > 1:
                    prompt = "这是一张长截图从上往下的第 %d/%d 段。逐条转写这一段里的文字（分清左边对方/右边本人），不要省略。" % (idx + 1, len(parts))
                r = LOCAL_HTTP.post(
                    base + "/api/vision",
                    json={"image": base64.b64encode(part).decode(), "mime": mime, "prompt": prompt},
                    timeout=120,
                )
                data = r.json()
                piece = str(data.get("text") or "").strip()
                if piece:
                    texts.append(piece)
                if not data.get("ok", True):
                    log_throttled("img-fail:" + str(data.get("error"))[:40], "第 %d 段识别失败：%s" % (idx + 1, data.get("error")))
            text = "\n".join(texts).strip()
            if len(text) > 1200:
                text = text[:1200] + "…"
            log("图片识别：", text[:80])
            return text
        except Exception as e:
            log_throttled("img-exc:" + type(e).__name__, "图片识别失败：", repr(e))
            return ""

    def transcribe_voice(msg):
        """语音消息 → 文字；失败返回空串。"""
        if not VOICE_ENABLED:
            log("语音识别已关闭（voice.enabled=false）")
            return ""
        try:
            import io
            import wave
            user = msg.get("username") or ""
            lid = msg.get("local_id")
            shard = msg.get("shard")
            if not user or lid is None:
                return ""
            path = _get_media().download_voice(user, int(lid), shard=shard)
            if not path:
                log("语音没落盘（这条微信没缓存到本地），跳过")
                return ""
            try:
                import pysilk
            except Exception:
                log("缺少 pysilk，装一下：pip install silk-python")
                return ""
            pcm = io.BytesIO()
            with open(path, "rb") as f:
                pysilk.decode(f, pcm, VOICE_SAMPLE_RATE)
            raw = pcm.getvalue()
            seconds = len(raw) / float(VOICE_SAMPLE_RATE * 2)
            if seconds < 0.3:
                log("语音太短（%.1fs），跳过" % seconds)
                return ""
            if seconds > VOICE_MAX_SECONDS:
                log("语音太长（%.0fs > %.0fs），跳过" % (seconds, VOICE_MAX_SECONDS))
                return ""
            wav_path = os.path.splitext(path)[0] + ".wav"
            with wave.open(wav_path, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(VOICE_SAMPLE_RATE)
                w.writeframes(raw)
            with open(wav_path, "rb") as f:
                text = asr_transcribe(f.read(), VOICE_API_KEY, VOICE_MODEL, VOICE_BASE_URL, VOICE_TIMEOUT)
            text = clean_transcript(text)
            log("语音识别（%.1fs）：%s" % (seconds, text[:60] or "（空）"))
            return text
        except Exception as e:
            log_throttled("voice-fail:" + type(e).__name__, "语音识别失败：", repr(e))
            return ""


    def on_message_inner(msg, listener):
        try:
            username = msg.get("username") or ""
            if not username:
                return
            mtype = msg.get("type") or ""
            content = (msg.get("content") or "").strip()
            # 有的微信版本把表情包报成「图片」，正文里还是 <emoji md5=...>：
            # 一律按表情包装死，绝不能送进视觉模型当图片认。
            if "<emoji" in content:
                log("收到表情包（被标成图片），装死（不识别不回）")
                return
            if mtype == "图片":
                desc = describe_image(msg)
                if not desc:
                    return
                content = "（对方发了一张图片，图里是：%s）" % desc
            if mtype == "语音":
                said = transcribe_voice(msg)
                if not said:
                    log("语音没识别出内容，先不说话")
                    return
                content = "（对方发了一条语音，说的是：%s）" % said
            if mtype in ("表情", "动画表情"):
                # 表情包发了装死：不去识别、不回话。以前会把表情包当图片认（截图/转码/
                # 送视觉模型），认出来还硬回一句，容易接岔；现在明确要的是「发了就装死」。
                log("收到表情包，装死（不识别不回）")
                return
            if mtype not in ("文本", "语音", "图片", "表情", "动画表情"):
                if "移出群聊" in content or "移出" in content:
                    dead_chats.add(username)
                    log("被移出群聊，停掉这个会话：", display_name(username))
                    return
                # 链接卡片 / 分享卡片：从 XML 里把 url 和 title 抠出来，当成一句带链接的话
                import re as _re
                mu = _re.search(r"<url>(.*?)</url>", content, _re.S)
                mt = _re.search(r"<title>(.*?)</title>", content, _re.S)
                if mu:
                    title = (mt.group(1).strip() if mt else "")[:60]
                    content = "分享了一个链接：%s %s" % (title, mu.group(1).strip())
                else:
                    return
            if ONLY_CHATS:
                try:
                    if display_name(username) not in ONLY_CHATS:
                        return
                except Exception:
                    return
            # 图片/语音/表情的 content 已经被上面替换成描述，别再重置回原始 XML
            if mtype == "文本":
                content = (msg.get("content") or "").strip()
            if not content or content.startswith("<"):
                return
            sender = msg.get("sender_username") or ""
            if sender == me:
                return  # 自己发的
            create_time = float(msg.get("create_time") or 0)
            if create_time and create_time < START_TS - SKIP_OLDER_THAN:
                return
            # 已经放了太久的消息（比如前面堵着几条），不再回
            if create_time and (time.time() - create_time) > STALE_AFTER:
                log("跳过过期消息（%.0fs 前）：%s" % (time.time() - create_time, content[:20]))
                return

            is_group = username.endswith("@chatroom")
            nickname = ""
            try:
                nickname = db.get_nickname(sender) or ""
            except Exception:
                nickname = ""
            if not nickname:
                nickname = "群友" if is_group else "微信好友"

            # 系统号 / 通知不接话：之前会跟「微信团队」对骂，还把通知当成人来问
            if is_system_notice(username, nickname, content):
                if ONLY_CHATS:
                    return
                log("跳过系统通知：", nickname, "：", content[:24])
                return
            # 同一人短时间内重复同一句 → 不再回（防刷屏 / 防通知重投）
            if duplicate_guard(username, sender, content):
                log("跳过重复消息：", nickname, "：", content[:20])
                return


            # 「拍了拍」这类系统提示不是人在说话，别接
            if "拍了拍" in content and "<url>" not in content:
                log("跳过拍一拍提示：", content[:24])
                return
            # 只把真正的 @ 当作 at_me；普通句子里提到「鲸鲸」不能误触发。
            # WeChat 会在 @昵称 后插入 U+2005，先换成普通空格再判定。
            import re as _mention_re
            _at_text = content.replace("\u2005", " ")
            addressed = any(
                a and _mention_re.search(
                    r"@\s*" + _mention_re.escape(str(a)) + r"(?=$|[\s，,：:！!~～…?？。\-—])",
                    _at_text,
                )
                for a in aliases
            )
            _at_remainder = _mention_re.sub(r"^[A-Za-z0-9_\-]{4,}:\s*", "", _at_text).strip()
            for _alias in aliases:
                if _alias:
                    _at_remainder = _mention_re.sub(r"@\s*" + _mention_re.escape(str(_alias)), " ", _at_remainder)
            _bare_mention = not _at_remainder.strip(" \t\r\n，,。.!！?？…~～")
            # 群里先说话、再单独发一个 @ → 把上一条问题补回来
            if username.endswith("@chatroom") and addressed and _bare_mention:
                try:
                    # get_messages 按新到旧返回；直接遍历，拿离这个裸 @ 最近的上一条。
                    for m in db.get_messages(username, limit=12):
                        if m.get("type") != "文本":
                            continue
                        if (m.get("sender_username") or "") != sender:
                            continue
                        prev = (m.get("content") or "").strip()
                        prev = __import__("re").sub(r"^[A-Za-z0-9_\-]{4,}:\s*", "", prev).strip()
                        if prev and not any(a in prev for a in aliases):
                            content = prev
                            log("补上一条问题：", prev[:20])
                            break
                except Exception as e:
                    log("补问题失败：", repr(e))
            # 把群消息里的其他 @ 对象一并交给服务端，帮助模型分清“你”是在说谁。
            _mentioned_names = []
            if is_group:
                for _hit in _mention_re.findall(r"@\s*([^\s@，,：:！!~～…?？。—]+)", _at_text):
                    _name = str(_hit).strip()
                    if _name and _name not in aliases and _name not in _mentioned_names:
                        _mentioned_names.append(_name)
            log("收到", ("群" if is_group else "私聊"), display_name(username), "←", nickname, "：", content[:30])
            payload = {
                "chat_id": username,
                "chat_type": "group" if is_group else "private",
                "user_id": sender or "unknown",
                "senderId": sender or "unknown",
                "sender_id": sender or "unknown",
                "senderName": nickname,
                "nickname": nickname,
                "text": content,
                "msg_id": "%s:%s:%s" % (username, msg.get("shard") or "", msg.get("local_id")),
                "at_me": addressed,
                "mentioned_names": _mentioned_names,
                "chat_title": display_name(username) if is_group else "",
            }


            try:
                headers = {"x-whale-bridge": "1"}
                if token:
                    headers["x-bot-token"] = token
                r = LOCAL_HTTP.post(
                    bot_url,
                    json=payload,
                    headers=headers,
                    timeout=120,
                )
                data = r.json()
            except Exception as e:
                _msg = repr(e)
                if "10061" in _msg or "refused" in _msg.lower() or "积极拒绝" in _msg:
                    log_throttled(
                        "conn-refused",
                        "连不上本地服务（积极拒绝 = 127.0.0.1 上没有程序在监听）。先双击「启动鲸鱼娘.bat」，等窗口出现「服务已启动」再来。",
                    )
                    if CONN_STATE.get("ok") is not False:
                        CONN_STATE["ok"] = False
                else:
                    log_throttled("webhook-fail:" + _msg[:40], "请求鲸鲸失败：", _msg)
                return

            if CONN_STATE.get("ok") is not True:
                CONN_STATE["ok"] = True
                log("已连上鲸鲸服务：", bot_url.rsplit("/webhook", 1)[0])
            if data.get("action") != "reply" or not data.get("reply"):
                if is_group and addressed:
                    log("鲸鲸没接话：", nickname, "→", content[:20], "|", data.get("reason"))
                return

            # 演示模式（服务端没配 Key，说的是内置台词）：提醒一次，别让人以为「没 Key 也能真聊」
            if data.get("mock") and not MOCK_NOTICED["done"]:
                MOCK_NOTICED["done"] = True
                log("[!] 服务端现在是「演示模式」：没配置 API Key，她回的是内置台词，不是真模型。")
                log("    去网页右上角「设置」填一把 Key（DeepSeek / 智谱 都行）就会切成真模型。")

            target = display_name(username)
            bubbles = data.get("bubbles") or [data["reply"]]
            mention = str(data.get("mention") or "").strip()
            # 生成期间又来了新消息 → 这条旧回复就不发了（避免回上一句）
            # 不再因为“有新消息”丢掉旧回复：宁可晚一点，也要回
            if not rate_guard(username):
                log("这一分钟回太多了，先停一下：", target)
                return
            log("回复", ("群" if is_group else "私聊"), target, "→", nickname, "：", (bubbles[0] or "")[:40])

            first = True
            for line in bubbles:
                if not line:
                    continue
                # 第一条如果是骂人/点名，用真 @（UI 里选成员），而不是纯文本 @名字
                if first and mention and is_group:
                    body = line
                    for prefix in ("@%s" % mention, "@ %s" % mention):
                        if body.startswith(prefix):
                            body = body[len(prefix):].lstrip(" ，,：:")
                            break
                    if send_at(mention, body, target, username):
                        first = False
                        time.sleep(0.6)
                        continue
                    log("真 @ 失败，退回普通文本：", mention)
                    if not line.startswith("@"):
                        line = "@%s %s" % (mention, line)
                send_text(line, target, username, quote_text=(content if first and QUOTE_REPLY else None))
                first = False
                time.sleep(0.6)
            # Stale/queued webhook payloads must claim a current-generation job;
            # local master OFF is silent even if an old server response has a sticker.
            _stk = data.get("sticker") or None
            if STICKER_TEST_ON and isinstance(_stk, dict):
                claim_and_send_sticker(_stk, expected_chat=target, expected_username=username)
        except Exception as e:
            log("处理消息异常：", repr(e))

    wait_for_server(bot_url, timeout=30)
    log("开始监听新消息…（Ctrl+C 退出）")
    pipeline = MessagePipeline(
        workers=PIPELINE_WORKERS,
        per_chat_limit=PIPELINE_QUEUE_LIMIT,
        log=log,
    )
    log("消息调度：%d 个 worker（同一会话串行、跨会话并发）" % PIPELINE_WORKERS)

    def sticker_test_loop():
        """常驻但默认休眠：关闭时不访问任何表情包接口、文件或窗口，也不打印日志。"""
        while True:
            try:
                if STICKER_TEST_ON and sticker_config_now() is not None:
                    response = LOCAL_HTTP.get(sticker_base + "/api/stickers/pending",
                                              headers=sticker_headers, timeout=3)
                    body = response.json() if response.status_code == 200 else None
                    items = body.get("items") if isinstance(body, dict) and body.get("ok") is True else []
                    for item in items if isinstance(items, list) else []:
                        if not STICKER_TEST_ON or sticker_config_now() is None:
                            break
                        claim_and_send_sticker(item)
            except Exception:
                # Network/auth/JSON failures are not permission to send or to
                # log an experimental feature while its switch is changing.
                pass
            time.sleep(5)

    threading.Thread(target=sticker_test_loop, daemon=True).start()


    def on_message(msg, listener):
        # 收（Listener 线程）→ 判（这里，按会话排队）→ 发（send_text 内部串行）
        # 以前是 max_workers=1：一张长截图的 OCR 能把后面所有消息堵几分钟。
        try:
            pipeline.submit(msg.get("username") or "unknown", on_message_inner, msg, listener)
        except Exception as e:
            log("提交消息处理失败：", repr(e))

    listener = Listener(db, interval=0.4)
    listener.add_all(on_message)
    listener.start()
    def recent_chats(limit=2, within=1800):
        out = []
        try:
            for s in db.get_sessions(limit=20):
                u = s.get("username") or ""
                if not u or u == "filehelper":
                    continue
                try:
                    ms = db.get_messages(u, limit=1)
                except Exception:
                    continue
                if not ms:
                    continue
                t = float(ms[0].get("create_time") or 0)
                if t and (time.time() - t) > within:
                    continue
                out.append((u, display_name(u)))
                if len(out) >= limit:
                    break
        except Exception:
            pass
        return out

    def notify_away():
        for u, name in recent_chats():
            send_text("我先去休息一下，晚点回你～", name, u, force=True)
            NOTIFIED.append((u, name))
            time.sleep(0.3)
        if NOTIFIED:
            log("已通知最近的聊天：", "、".join(n for _, n in NOTIFIED))

    def share_watch():
        """每隔一段时间自己刷 B 站热门，挑一个没分享过的发到最近活跃的群/私聊。"""
        state_file = os.path.join(ROOT, "data", "share-state.json")
        try:
            with open(state_file, "r", encoding="utf-8") as f:
                last = float(json.load(f).get("lastTs") or 0)
        except Exception:
            last = 0.0
        if not last:
            # 首次启动：5 分钟后再发，别一开机就刷屏
            last = time.time() - SHARE_EVERY * 60 + 60
        while True:
            time.sleep(30)
            if not SHARE_ENABLED:
                continue
            if time.time() - last < SHARE_EVERY * 60:
                continue
            if game_running() or away_active() or foreground_is_fullscreen():
                continue
            target = recent_chats(limit=1, within=7200)
            if not target:
                log("没有最近活跃的会话，这次先不分享")
                last = time.time()
                continue
            u, name = target[0]
            try:
                base = bot_url.rsplit("/webhook", 1)[0]
                r = LOCAL_HTTP.get(base + "/api/share?chat=" + urllib.parse.quote(u), timeout=40)
                data = r.json()
            except Exception as e:
                log("拉取视频失败：", repr(e))
                last = time.time()
                continue
            video = data.get("video")
            last = time.time()
            try:
                with open(state_file, "w", encoding="utf-8") as f:
                    json.dump({"lastTs": last}, f)
            except Exception:
                pass
            if not video:
                log("这次没挑到合适的视频")
                continue
            title = str(video.get("title") or "")[:60]
            link = str(video.get("url") or "")
            topic = str(data.get("topic") or "").strip()
            comment = str(data.get("comment") or "").strip()
            if not comment:
                comment = random.choice([
                    "这个看着还行，评论区比视频有意思",
                    "刚刷到，你们看看",
                    "有点意思，我接着刷了",
                ])
            text = "%s\n%s" % (link, comment)
            log("主动分享视频 →", name, str(video.get("title"))[:30])
            send_text(text, name, u)

    def care_watch():
        """主动搭话：没事的时候她自己来问一句「在干啥 / 累不累」。

        和主动分享同一套节奏，但「该不该发」交给服务端判断（时间窗 / 频率 / 每日上限都在
        src/care.js 里，改配置不用改脚本）。这里只管三件事：到点问一次、挑一个不是正在聊的
        会话、把生成的话发出去。
        """
        state_file = os.path.join(ROOT, "data", "care-state.json")

        def load_state():
            try:
                with open(state_file, "r", encoding="utf-8") as f:
                    return json.load(f) or {}
            except Exception:
                return {}

        def save_state(st):
            try:
                os.makedirs(os.path.dirname(state_file), exist_ok=True)
                with open(state_file, "w", encoding="utf-8") as f:
                    json.dump(st, f, ensure_ascii=False)
            except Exception:
                pass

        while True:
            time.sleep(60)
            if not CARE_ENABLED:
                continue
            if game_running() or away_active() or foreground_is_fullscreen():
                continue
            st = load_state()
            last_ts = float(st.get("lastTs") or 0)
            today = time.strftime("%Y-%m-%d")
            sent = int(st.get("count") or 0) if st.get("day") == today else 0
            base = bot_url.rsplit("/webhook", 1)[0]
            try:
                r = requests.get(
                    base + "/api/care/due",
                    params={"last": int(last_ts * 1000), "sentToday": sent},
                    timeout=15,
                )
                due = r.json() or {}
            except Exception:
                continue
            if not due.get("due"):
                continue
            # 正在聊的会话先别打扰：连续 CARE_QUIET_MIN 分钟内有过消息就跳过
            active = set()
            if CARE_QUIET_MIN > 0:
                try:
                    active = set(u for u, _n in recent_chats(limit=50, within=int(CARE_QUIET_MIN * 60)))
                except Exception:
                    active = set()
            target = None
            try:
                for u, name in recent_chats(limit=8, within=7 * 86400):
                    if u in active:
                        continue
                    is_group = str(u).endswith("@chatroom")
                    # 群聊默认绝不主动（除非显式 care.allowGroups）
                    if is_group and not CARE_ALLOW_GROUPS:
                        continue
                    # 默认只找主人：不是主人的私聊/群一律跳过（除非显式 care.allowOthers）
                    if CARE_ONLY_MASTER and not CARE_ALLOW_OTHERS:
                        if str(u) != str(MASTER_WXID):
                            continue
                    target = (u, name)
                    break
            except Exception:
                target = None
            if not target:
                log_throttled(
                    "care-busy",
                    "主动搭话：最近 %d 分钟内聊过的会话都跳过（quietAfterMinutes），这次不打扰" % int(CARE_QUIET_MIN),
                    ttl=1800,
                )
                continue
            u, name = target
            try:
                r2 = LOCAL_HTTP.get(base + "/api/care", params={"chat": u}, timeout=40)
                text = str((r2.json() or {}).get("text") or "").strip()
            except Exception as e:
                log("生成搭话失败：", repr(e))
                continue
            if not text:
                continue
            log("主动搭话 →", name, text[:30])
            ok = send_text(text, name, u)
            # 发失败也要记一次时间：以前失败不写状态，于是每 60 秒重试一次，
            # 日志里就出现「每分钟都在主动搭话」的刷屏（实测 158 条）。
            save_state({"lastTs": time.time(), "day": today, "count": sent + (0 if ok is False else 1)})


    BATTERY_SENT = {"done": False}

    def battery_watch():
        while True:
            time.sleep(30)
            try:
                import psutil
                b = psutil.sensors_battery()
            except Exception:
                continue
            if not b or b.percent is None:
                continue
            pct = float(b.percent)
            if pct > 10:
                BATTERY_SENT["done"] = False
                continue
            if pct <= LOW_BATTERY_PCT and not BATTERY_SENT["done"]:
                BATTERY_SENT["done"] = True
                log("电量低（%.0f%%），给最近 3 个会话发晚安" % pct)
                try:
                    for u, name in recent_chats(limit=3, within=86400):
                        send_text(GOODNIGHT_TEXT, name, u, force=True)
                        time.sleep(0.4)
                except Exception as e:
                    log("发晚安失败：", repr(e))

    def notify_back():
        for u, name in list(NOTIFIED):
            send_text("我回来啦，刚在打游戏", name, u, force=True)
            time.sleep(0.3)
        NOTIFIED.clear()

    def game_watch():
        while True:
            time.sleep(4)
            running = game_running()
            if running and not AWAY["on"]:
                AWAY["on"] = True
                log("检测到游戏运行，进入休息模式（回复先排队）")
                if AWAY_NOTICE and not game_running():
                    try:
                        notify_away()
                    except Exception as e:
                        log("休息通知失败：", repr(e))
            elif not running and AWAY["on"]:
                AWAY["on"] = False
                log("游戏已退出，补发排队消息")
                with pending_lock:
                    items = list(pending_replies.values())
                    pending_replies.clear()
                now = time.time()
                fresh = [x for x in items if now - x[3] <= QUEUED_MAX_AGE]
                dropped = len(items) - len(fresh)
                fresh = fresh[-QUEUED_MAX_CHATS:]
                if dropped:
                    log("排队里有 %d 条已经太旧（>%ds），不补发" % (dropped, int(QUEUED_MAX_AGE)))
                for text, target, uname, _ts in fresh:
                    send_text(text, target, uname, force=True)
                if RETURN_NOTICE:
                    try:
                        notify_back()
                    except Exception as e:
                        log("回来通知失败：", repr(e))

    _UIA_READY = {"ts": 0.0, "ok": None, "msg": "", "res": None}

    def ensure_uia_ready(force=False):
        """挑「PID 里真有 Weixin.dll」的窗口并按真判据物化 UIA。

        修的是这三件事：过期 hwnd 被当成微信主窗（日志里那个不存在的 PID）、
        第三方库只看根窗口类名就判成功、以及版本表没有 4.2.0.9 时候选 RVA 试错。
        结果缓存 30 秒，避免每次发送都扫一遍。
        """
        if uia_boot is None:
            return _UIA_READY
        now = time.time()
        if not force and (now - _UIA_READY["ts"]) < 30:
            return _UIA_READY
        prefer = 0
        try:
            prefer = int(ACCOUNT.get("hwnd") or 0)
        except Exception:
            prefer = 0
        try:
            res = uia_boot.ensure(prefer_hwnd=prefer, log=log)
        except Exception as e:                      # noqa: BLE001
            res = {"ok": False, "reason": "exception: %r" % (e,)}
        try:
            msg = uia_boot.describe(res)
        except Exception:
            msg = "UIA 自检失败"
        _UIA_READY.update({"ts": now, "ok": bool(res.get("ok")), "msg": msg, "res": res})
        if res.get("ok"):
            h = int(res.get("hwnd") or 0)
            if h and h != prefer:
                ACCOUNT["hwnd"] = h
            log("发送通道预热：" + msg)
        else:
            log("发送通道预热：" + msg)
        return _UIA_READY

    def explain_uia_failure():
        """UIA 拿不到时把原因说清楚（先用 uia_boot 的真判据，再退老的分支分析）。"""
        if uia_boot is not None:
            try:
                r = ensure_uia_ready(force=True)
                if r.get("ok"):
                    return
            except Exception:                       # noqa: BLE001
                pass
        return _explain_uia_failure_detail()

    def _explain_uia_failure_detail():
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
            log("UIA 诊断不可用：", repr(e))
            return
        hwnd = int(ACCOUNT.get("hwnd") or 0) or find_weixin_hwnd()
        if not hwnd:
            log("UIA 诊断：找不到标题为「微信」的主窗（微信缩在托盘？先点开它）")
            return
        try:
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            mods = list(AccessibilityGate._process_modules(pid) or [])
        except Exception as e:
            log("UIA 诊断：枚举模块失败：", repr(e))
            return
        dll = None
        for _b, _s, name, path in mods:
            if (name or "").lower() == "weixin.dll":
                dll = path
                break
        if not dll:
            log("UIA 诊断（原因A）：主窗进程 pid=%s 里只有 %d 个模块，枚举不到 Weixin.dll" % (pid, len(mods)))
            log("    → 多见于：微信刚重启、主窗属于子进程、或与微信权限不一致")
            return
        ver = os.path.basename(os.path.dirname(dll))
        try:
            cands = AccessibilityGate._qaccessible_candidate_rvas(dll)
        except Exception as e:
            log("UIA 诊断：取候选 RVA 失败：", repr(e))
            return
        known = QACCESSIBLE_ACTIVE_RVA_BY_VERSION.get(ver)
        if not cands:
            log("UIA 诊断（原因B）：微信 %s 没有任何可用 gate RVA，这个版本库还不支持" % ver)
            log("    → 升级 wechatauto-replica，或换回 4.1.13.65 / 4.1.15.53")
        else:
            log("UIA 诊断（原因C）：微信 %s，候选 RVA %d 个（%s），补丁写了但 mmui 没出现" % (
                ver, len(cands),
                "版本表命中" if known is not None else "靠特征扫描",
            ))
            log("    → 重启微信后立刻重试；仍失败说明该版本的保护变了，等库更新")

    def warmup():
        """启动后预热发送通道，避免第一条回复慢 5~10 秒。"""
        time.sleep(3)
        if game_running():
            log("游戏在运行，跳过发送通道预热")
            return
        try:
            nonlocal gui
            ensure_uia_ready(force=True)
            with gui_lock:
                if gui is None:
                    gui = WeChatGUI()
            u = gui._get_uia()
            UIA_CACHE["u"] = u
            if u is None:
                log("发送通道预热：UIA 不可用（只剩 OCR 兜底，先跑「一键修复并自检.bat」）")
                explain_uia_failure()
            else:
                win = getattr(u, "_win", None)
                try:
                    wcls = win.ClassName if win is not None else None
                    wname = win.Name if win is not None else None
                except Exception:                # noqa: BLE001
                    wcls, wname = None, None
                log("发送通道预热完成（UIA 可用，主窗类名=%r 名称=%r）" % (wcls, wname))
                # 认账号窗口要放在 UIA 起来之后：ensure_window 会热激活 gate 字节，
                # 窗口树物化了才读得到会话行，才分得清哪个窗口是哪个号。
                try:
                    if pick_account_window(quiet=True):
                        if ACCOUNT.get("hwnd"):
                            rebind_uia(ACCOUNT["hwnd"], u)
                        log("账号窗口已确认：hwnd=%s（%s）"
                            % (ACCOUNT.get("hwnd"), ACCOUNT.get("why") or ""))
                    else:
                        log("⚠️ 账号窗口没确认（%s）：发送会先被拦下来，直到能认出来"
                            % (ACCOUNT.get("why") or "未知"))
                except Exception as e:            # noqa: BLE001
                    log("账号窗口识别失败：", repr(e))
        except Exception as e:
            log("发送通道预热失败：", repr(e))

    def send_watchdog():
        """发送卡住超过 40 秒就重启桥接，避免整个队列卡死。"""
        while True:
            time.sleep(5)
            if SEND_STATE["active"] and (time.time() - SEND_STATE["start"]) > 40:
                log("发送卡住超过 40 秒，强制重启桥接进程…")
                time.sleep(0.3)
                # 用 7 而不是 2：2 是「找不到数据库目录」这种优雅报错（不该被守护循环
                # 无限重启），7 才是「我自己要重启」—— 启动脚本看到 7 就连着重启。
                os._exit(7)

    def flush_pending():
        while True:
            time.sleep(2)
            if AWAY["on"] or away_active() or foreground_is_fullscreen():
                continue
            with pending_lock:
                if not pending_replies:
                    continue
                items = list(pending_replies.values())
                pending_replies.clear()
            now = time.time()
            fresh = [x for x in items if now - x[3] <= QUEUED_MAX_AGE][-QUEUED_MAX_CHATS:]
            for text, target, uname, _ts in fresh:
                log("补发排队消息 →", target)
                send_text(text, target, uname, force=True)

    def listener_alive():
        """收消息的轮询线程是否还活着。"""
        try:
            th = getattr(listener, "_thread", None)
            return bool(th is not None and th.is_alive())
        except Exception:
            return False

    def listener_watch():
        """轮询线程死了就把它拉起来。

        症状：桥接进程还在（心跳正常）、微信里发消息也进来了，但一条都不回复 ——
        因为读数据库的那个线程悄悄退出了。以前只能重启桥接。
        """
        misses = 0
        while True:
            time.sleep(15)
            if listener_alive():
                misses = 0
                continue
            misses += 1
            if misses < 2:
                continue
            log("[!] 收消息线程已经不在了，自动重启监听…")
            try:
                listener.start()
                if listener_alive():
                    log("监听已重启，继续收消息")
                else:
                    log("监听重启后仍未启动，建议重启桥接")
            except Exception as e:                 # noqa: BLE001
                log("监听重启失败：", repr(e))
            misses = 0

    def bridge_heartbeat():
        """每 20 秒告诉服务端「桥接还活着、UIA/ffmpeg 状态如何」。

        没有心跳时，服务端只知道「它收到了消息」，不知道回复到底有没有能力发出去；
        网页上也就没法提示「桥接离线」或「UIA 不可用」。
        """
        import shutil as _shutil

        nonlocal gui
        base = bot_url.rsplit("/webhook", 1)[0]
        misses = 0
        gate_logged = False
        while True:
            try:
                # 游戏在跑时桥接会跳过预热、进休息模式，这时 UIA 还没初始化，
                # 不能当成「UIA 坏了」上报 —— 不然网页会误报「消息发不出去」。
                resting = bool(game_running())
                # 不用等消息才去唤醒引擎：心跳每 20 秒问一次（库内部 30 秒节流、
                # 会自动重新热激活），这样状态是真实的，也能顺手把假死的引擎救回来。
                uia_now = None
                if not resting:
                    try:
                        if not wechat_window_alive():
                            # 微信主窗没了（进程更新/重启/被回收）。缓存引擎里那个窗口
                            # 句柄已失效，再调 UIA 可能直接 0xC0000005，Python 拦不住。
                            # 先把手里的引擎丢掉，等窗口回来再重建，别去碰它。
                            with gui_lock:
                                gui = None
                                UIA_CACHE["u"] = None
                            misses = 0
                            uia_now = False
                            if not gate_logged:
                                log("[!] 微信主窗当前不存在（可能缩进托盘/被回收/自更新），已收起 UIA 引擎，等窗口回来再预热")
                                gate_logged = True
                        else:
                            with gui_lock:
                                _u = gui._get_uia() if gui is not None else None
                            if _u is None:
                                # 微信缩在托盘时它的 UI 子树被销毁，UIA 必然拿不到。
                                # 先让 uia_boot 把窗口"正常打开"一次（等同用户点托盘图标，
                                # 只是最后一次单实例转发）；它建完树会自动把窗口收回托盘，
                                # 用户看不见，但控件树留着，后续发送就能走 UIA。
                                _ready = ensure_uia_ready(force=True)
                                if _ready.get("ok"):
                                    with gui_lock:
                                        gui = WeChatGUI()
                                        _u = gui._get_uia()
                                    if _u is not None:
                                        misses = 0
                                        gate_logged = False
                                if _u is None:
                                    misses += 1
                                if _u is None and misses >= 3:
                                    log("[!] UIA 连续 %d 次拿不到，重建窗口驱动再试…" % misses)
                                    with gui_lock:
                                        gui = WeChatGUI()
                                        _u = gui._get_uia()
                                    if _u is not None:
                                        misses = 0
                            else:
                                misses = 0
                                gate_logged = False
                            UIA_CACHE["u"] = _u
                            uia_now = _u is not None
                    except Exception:
                        uia_now = UIA_CACHE.get("u") is not None
                payload = {
                    "platform": "wechat",
                    "uia": uia_now,
                    "rest": resting,
                    # 收消息线程还活着吗：死了就是「能心跳、但一条消息都不进来」
                    "listener": listener_alive(),
                    "ffmpeg": bool(_shutil.which("ffmpeg")),
                    # 多账号：网页要显示「桥接现在到底在用哪个号、窗口确认了没有」
                    "account": db.account,
                    "account_wxid": db.wxid,
                    "account_nick": _self_nick,
                    "account_ok": bool(ACCOUNT.get("verified")),
                    "account_why": str(ACCOUNT.get("why") or ""),
                    "account_guard": bool(ACCOUNT_GUARD),
                }
                headers = {"x-whale-bridge": "1"}
                if token:
                    headers["x-bot-token"] = token
                LOCAL_HTTP.post(base + "/api/bridge/heartbeat", json=payload, headers=headers, timeout=8)
            except Exception:
                pass  # 服务没起来/重启中，下一轮再报
            time.sleep(20)

    def config_watch():
        """盯 config.json 的修改时间：调试台一保存就热更新，不用重启桥接。

        以前这些开关只在启动时读一次，用户在 /debug 里关掉「主动分享」、
        改「忽略名单」、「游戏白名单」都没反应，只能重启桥接 —— 也就是
        「调了没用，还是默认」。
        """
        last = 0.0
        try:
            last = os.path.getmtime(CONFIG_PATH)
        except Exception:
            last = 0.0
        while True:
            time.sleep(5)
            try:
                mt = os.path.getmtime(CONFIG_PATH)
            except Exception:
                continue
            if mt <= last:
                continue
            last = mt
            if reload_config():
                log("配置已热更新（调试台改完即时生效，不用重启桥接）")

    threading.Thread(target=flush_pending, daemon=True).start()
    threading.Thread(target=config_watch, daemon=True).start()
    threading.Thread(target=game_watch, daemon=True).start()
    threading.Thread(target=warmup, daemon=True).start()
    threading.Thread(target=send_watchdog, daemon=True).start()
    threading.Thread(target=battery_watch, daemon=True).start()
    threading.Thread(target=share_watch, daemon=True).start()
    threading.Thread(target=care_watch, daemon=True).start()
    threading.Thread(target=bridge_heartbeat, daemon=True).start()
    threading.Thread(target=listener_watch, daemon=True).start()
    log("已启动。鲸鲸地址：", bot_url)

    # 就绪标记：外部（守护脚本 / 自检）据此判断「进程在，但可能卡在初始化」
    try:
        import json as _json, datetime as _dt
        import shutil as _shutil2
        with open(os.path.join(ROOT, "data", "bridge-ready.json"), "w", encoding="utf-8") as _rf:
            _json.dump({
                "readyAt": _dt.datetime.now().isoformat(timespec="seconds"),
                "pid": os.getpid(),
                "botUrl": bot_url,
                "ffmpeg": bool(_shutil2.which("ffmpeg")),
            }, _rf, ensure_ascii=False)
    except Exception:
        pass

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        log("正在退出…")
        try:
            pipeline.close(wait=False)
        except Exception:
            pass
        listener.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
