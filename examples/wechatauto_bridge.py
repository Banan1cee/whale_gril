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

注意：
  - 发送消息会抢微信窗口焦点，这是 4.x 自动化的正常表现。
  - 微信必须保持登录；退出登录后数据库密钥会失效。
  - 自动化不是微信官方接口，仍有账号风险，只用小号 + 测试群。
"""

import json
import random
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
from concurrent.futures import ThreadPoolExecutor
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(ROOT, "config.json")
LOG_FILE = os.path.join(ROOT, "data", "wechat-bridge-4x.log")

# 只回复这些会话（留空 = 全部会话都交给鲸鲸判断）
# 例如 ["文件传输助手", "深海鱼塘"]
ONLY_CHATS = []

# 距离启动多久之前的消息不处理（秒）
SKIP_OLDER_THAN = 10
DIGEST_MINUTES = 30
MASTER_WXID = ''
# 超过这么多秒的旧消息直接不回，避免“回上一条”
STALE_AFTER = float(os.environ.get("WHALE_STALE_AFTER", "4"))
try:
    _cfg_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "config.json")
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
    QUOTE_REPLY = bool(_wechat.get("quoteReply", True))
    # UIA 彻底发不出去时，退到「Ctrl+F 搜索会话 → 粘贴 → 回车」的键盘通道（会抢前台）
    KEYBOARD_FALLBACK = bool(_wechat.get("keyboardFallback", True))
    # 后台发送：不抢前台直接发（实测最小化/被遮挡也能发）。false = 每次先把微信拉到前台
    BACKGROUND_SEND = bool(_wechat.get("backgroundSend", True))
    LOW_BATTERY_PCT = float(_wechat.get("lowBatteryPercent", 5))
    GOODNIGHT_TEXT = str(_wechat.get("goodnightText", "晚安，电量快没了，我先睡啦，明天见～"))
    _share = _cfg.get("share") or {}
    SHARE_ENABLED = bool(_share.get("enabled", True))
    SHARE_EVERY = float(_share.get("everyMinutes", 120))
    # 主动搭话（问「在干啥 / 累不累」）。时间窗和频率由服务端 /api/care/due 算，这里只留一个开关和静默期
    _care = _cfg.get("care") or {}
    CARE_ENABLED = bool(_care.get("enabled", True))
    CARE_QUIET_MIN = float(_care.get("quietAfterMinutes", 20) or 0)
    _digest = _wechat.get("digestMinutes", 30)
    DIGEST_MINUTES = float(_digest) if isinstance(_digest, (int, float)) else 30.0
    MASTER_WXID = (((_cfg.get("persona") or {}).get("master") or {}).get("wxids") or [''])[0]
except Exception:
    pass

START_TS = time.time()


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
    global SHARE_ENABLED, SHARE_EVERY, CARE_ENABLED, CARE_QUIET_MIN, DIGEST_MINUTES
    global STALE_AFTER, SYSTEM_SENDER_NAMES, BASE_SYSTEM_SENDERS, MASTER_WXID
    global VOICE_ENABLED, VOICE_BASE_URL, VOICE_MODEL
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
    QUOTE_REPLY = bool(w.get("quoteReply", True))
    KEYBOARD_FALLBACK = bool(w.get("keyboardFallback", True))
    BACKGROUND_SEND = bool(w.get("backgroundSend", True))
    GOODNIGHT_TEXT = str(w.get("goodnightText") or GOODNIGHT_TEXT)
    try:
        DIGEST_MINUTES = float(w.get("digestMinutes", 30))
    except Exception:
        DIGEST_MINUTES = 30.0
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
    CARE_ENABLED = bool(ca.get("enabled", True))
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

    兼容三种布局：
      E:\\xwechat_files\\<账号>\\db_storage
      E:\\xwechat_files\\db_storage            （账号目录层级被拍平）
      直接把 <账号> 目录填进来
    """
    if not p or not os.path.isdir(p):
        return False
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

    # 3) 所有固定盘的根目录
    for letter in drives:
        for name in DB_ROOT_NAMES:
            cand = os.path.join(letter + ":\\", name)
            if looks_like_db_root(cand):
                return cand
    return ""

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
try:
    _voice_cfg = (_cfg.get("voice") or {})
    VOICE_ENABLED = bool(_voice_cfg.get("enabled", True))
    VOICE_BASE_URL = str(_voice_cfg.get("baseUrl") or VOICE_BASE_URL)
    VOICE_MODEL = str(_voice_cfg.get("model") or VOICE_MODEL)
    VOICE_API_KEY = str(_voice_cfg.get("apiKey") or "")
    VOICE_TIMEOUT = float(_voice_cfg.get("timeoutMs", 90000)) / 1000.0
    VOICE_MAX_SECONDS = float(_voice_cfg.get("maxSeconds", 120))
    if not VOICE_API_KEY:
        try:
            _settings_path = os.path.join(ROOT, "data", "settings.json")
            with open(_settings_path, "r", encoding="utf-8-sig") as _sf:
                _st = json.load(_sf)
            VOICE_API_KEY = str(_st.get("apiKey") or "")
        except Exception:
            VOICE_API_KEY = ""
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
    port = (cfg.get("server") or {}).get("port", 8787)
    return os.environ.get("WHALE_BOT_URL", "http://127.0.0.1:%s/webhook/wechat" % port)


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
            log("找到 ffmpeg：", exe, "（微信图片是 wxgf/HEVC，靠它转 jpg）")
            return True
    log("[!] 没找到 ffmpeg：微信 4.x 的图片多是 wxgf/HEVC，没有它就看不了图。")
    log("    装一个（解压到 C:\\ffmpeg 即可）或把 ffmpeg.exe 放进 runtime\\ffmpeg\\bin")
    return False


def main():
    boot("进入 main()")
    ensure_ffmpeg_env()
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
        log("请先运行：\"%LOCALAPPDATA%\\Programs\\Python\\Python312\\python.exe\" -m pip install wechatauto-replica requests")
        return 1

    cfg = read_config()
    gw = (cfg.get("gateway") or {}).get("wechat") or {}
    token = gw.get("inboundToken", "")
    bot_url = build_bot_url(cfg)
    aliases = ((cfg.get("persona") or {}).get("aliases") or []) + [
        ((cfg.get("persona") or {}).get("name") or "鲸鲸")
    ]

    log("连接微信 4.x 数据库（只读）…")
    # token 一定要读到：读不到就是「她不理人」最隐蔽的原因（服务端会直接 401）
    if token:
        log("webhook token：已读取（%s…）" % token[:6])
    else:
        log("⚠️ webhook token 是空的！检查 config.json 的 gateway.wechat.inboundToken（文件要能正常解析）")
    db_dir = resolve_db_dir()
    if db_dir:
        log("数据库目录：", db_dir)
    try:
        db = WeChatDB(db_dir=db_dir) if db_dir else WeChatDB()
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
    _media_box = {"downloader": None}

    def _get_media():
        """按需创建媒体下载器；图片和表情识别共用一个实例。"""
        if _media_box["downloader"] is None:
            save_dir = os.path.join(ROOT, "data", "media-cache")
            os.makedirs(save_dir, exist_ok=True)
            _media_box["downloader"] = MediaDownloader(db, save_dir=save_dir)
        return _media_box["downloader"]

    me = db.wxid
    try:
        info = db.get_self_info() or {}
        log("当前登录账号：", info.get("nick_name") or info.get("remark") or me)
    except Exception:
        log("当前登录账号 wxid：", me)
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

        实测：群 45063658812@chatroom 在数据库里 nick_name 是空的，会话列表里显示
        「宇火之于、云白『世一区』」—— 按群名/open_chat 都匹配不上，所以这里把
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
            h = find_weixin_hwnd()
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
        hwnd = find_weixin_hwnd()
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
        """把微信强制拉到前台（SetForegroundWindow 单用会被系统拒绝）。"""
        try:
            import ctypes
            user32 = ctypes.windll.user32
            if user32.GetForegroundWindow() == hwnd:
                return True
            fg = user32.GetForegroundWindow()
            tid_fg = user32.GetWindowThreadProcessId(fg, None)
            tid = user32.GetWindowThreadProcessId(hwnd, None)
            try:
                user32.AttachThreadInput(tid_fg, tid, True)
                user32.ShowWindow(hwnd, 9)  # SW_RESTORE
                user32.SetForegroundWindow(hwnd)
                user32.BringWindowToTop(hwnd)
            finally:
                try:
                    user32.AttachThreadInput(tid_fg, tid, False)
                except Exception:
                    pass
            time.sleep(0.15)
            return True
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
            hwnd = find_weixin_hwnd()
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
            snap["hwnd"] = find_weixin_hwnd() or 0
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

    def uia_send(text, who, username=""):
        """优先用 UIA 发送：不依赖 OCR 找发送按钮，成功后返回 True。"""
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

        hwnd = find_weixin_hwnd()
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
        with send_lock:
            if not force and (AWAY["on"] or away_active() or game_running() or foreground_is_fullscreen()):
                with pending_lock:
                    pending_replies[chat_username or chat_display_name] = (text, chat_display_name, chat_username, time.time())
                log("游戏/全屏中，先排队：", chat_display_name)
                return True
            with gui_lock:
                if gui is None:
                    log("初始化微信窗口驱动…（会抢一下焦点，约 5~10 秒）")
                    gui = WeChatGUI()
            # ⓪ 引用回复（引用对方那条消息）——比普通发送慢，失败自动回退
            if quote_text and QUOTE_REPLY:
                try:
                    if with_window_on_top(lambda: gui.quote_msg(text, who=chat_display_name, target_text=quote_text, verify=False)):
                        log("引用回复成功 →", chat_display_name)
                        return True
                except Exception as e:
                    log("引用回复失败，回退普通发送：", repr(e))
            # ① 首选 UIA：稳定、快，不依赖 OCR 找发送按钮
            t_start = time.time()
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
                    _box = {}

                    def _ocr_send():
                        try:
                            _box["r"] = with_window_on_top(
                                lambda: gui.send_msg(text, chat_display_name, True))
                        except Exception as _e:      # noqa: BLE001
                            _box["e"] = _e

                    _th = threading.Thread(target=_ocr_send, daemon=True)
                    _th.start()
                    _th.join(25)
                    if _th.is_alive():
                        log("OCR 兜底 25 秒没返回（卡在截屏），放弃这条，等下次消息")
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
            if chat_username:
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
        with send_lock:
            with gui_lock:
                if gui is None:
                    log("初始化微信窗口驱动…（会抢一下焦点，约 5~10 秒）")
                    gui = WeChatGUI()
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
                r = requests.post(
                    base + "/api/vision",
                    json={"image": base64.b64encode(part).decode(), "mime": mime, "prompt": prompt},
                    timeout=120,
                )
                data = r.json()
                piece = str(data.get("text") or "").strip()
                if piece:
                    texts.append(piece)
                if not data.get("ok", True):
                    log("第 %d 段识别失败：%s" % (idx + 1, data.get("error")))
            text = "\n".join(texts).strip()
            if len(text) > 1200:
                text = text[:1200] + "…"
            log("图片识别：", text[:80])
            return text
        except Exception as e:
            log("图片识别失败：", repr(e))
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
            log("语音识别失败：", repr(e))
            return ""

    def _account_root():
        try:
            for rel, path, _ in db._db_files:
                if os.path.basename(path).startswith("message_"):
                    p = os.path.dirname(path)
                    while p and not os.path.basename(p).startswith(("wxid", "all_users")):
                        parent = os.path.dirname(p)
                        if parent == p:
                            break
                        p = parent
                    return p
        except Exception:
            pass
        return ""

    def _find_sticker_file(md5):
        root = _account_root()
        if not root or not md5:
            return ""
        roots = [os.path.join(root, "cache"), os.path.join(root, "msg", "attach")]
        for base in roots:
            for dirpath, _dirs, files in os.walk(base):
                for name in files:
                    if md5 in name:
                        return os.path.join(dirpath, name)
        return ""

    def _sticker_label(content):
        """从表情 XML 的 desc（base64 protobuf）里提取表情名，比如「鲸鱼娘」"""
        try:
            import base64
            import re
            m = re.search(r'desc\s*=\s*"([^"]*)"', content or "")
            if not m:
                return ""
            raw = base64.b64decode(m.group(1))
            txt = raw.decode("utf-8", "ignore")
            parts = [x for x in re.findall(r"[\u4e00-\u9fa5A-Za-z0-9_]{2,}", txt) if x.lower() != "default"]
            return " ".join(parts[:3])
        except Exception:
            return ""

    def screenshot_sticker(who):
        """截图当前聊天窗口，让视觉模型找最新那条表情包（缓存解不开时的兜底）"""
        try:
            import io
            import base64
            import win32gui
            from PIL import ImageGrab
            hwnd = find_weixin_hwnd()
            if not hwnd:
                return ""
            try:
                u = UIA_CACHE.get("u") or (gui._get_uia() if gui is not None else None)
                if u is not None and who:
                    u.open_chat(who)
                    time.sleep(0.8)
            except Exception:
                pass
            force_foreground(hwnd)
            time.sleep(0.4)
            r = win32gui.GetWindowRect(hwnd)
            # 只截聊天区最底部一条消息，避免看到上面的旧表情包
            box = (int(r[0] + (r[2] - r[0]) * 0.30), int(r[1] + (r[3] - r[1]) * 0.45), r[2] - 8, r[3] - 120)
            img = ImageGrab.grab(bbox=box)
            # 放大一点，避免小表情包被视觉模型看糊
            img = img.resize((int(img.width * 1.3), int(img.height * 1.3)), 1)
            buf = io.BytesIO()
            img.save(buf, "JPEG", quality=90)
            base = bot_url.rsplit("/webhook", 1)[0]
            resp = requests.post(base + "/api/vision", json={
                "image": base64.b64encode(buf.getvalue()).decode(),
                "mime": "image/jpeg",
                "prompt": "这是微信聊天窗口下半部分截图，最新消息在最底部、紧贴输入框。只看最底部那一条消息：如果它是表情包/图片，描述画面内容（人物/动物/文字梗）；如果最底部不是表情包，回答「看不清」。不要描述它上面的任何历史消息。",
            }, timeout=60)
            text = str(resp.json().get("text") or "").strip()
            log("表情包截图识别：", text[:40])
            if "看不清" in text or "模糊" in text:
                return ""
            return text
        except Exception as e:
            log("表情包截图识别失败：", repr(e))
            return ""

    def describe_sticker(msg):
        """表情包：按 XML 里的 md5 找本地缓存，转成 jpg 再交给视觉模型。"""
        try:
            import base64
            import re
            import subprocess
            content = str(msg.get("content") or "")
            who = display_name(msg.get("username") or "")
            m = re.search(r'md5="([0-9a-fA-F]{32})"', content)
            md5 = m.group(1).lower() if m else ""
            if not md5:
                shot = screenshot_sticker(who)
                return shot or _sticker_label(content)
            path = _find_sticker_file(md5)
            if not path:
                shot = screenshot_sticker(who)
                if shot:
                    return shot
                return _sticker_label(content)
            with open(path, "rb") as f:
                raw = f.read()
            jpg = None
            if raw[:4] == b"wxgf":
                jpg = _get_media()._wxgf_to_jpg(raw)
            elif raw[:3] == b"\xff\xd8\xff" or raw[:8] == b"\x89PNG\r\n\x1a\n":
                jpg = raw
            else:
                try:
                    import shutil as _sh
                    exe = _sh.which("ffmpeg")
                    if not exe:
                        exe = _get_media()._ffmpeg_exe()
                    if exe:
                        out = path + ".jpg"
                        subprocess.run([exe, "-y", "-i", path, "-frames:v", "1", out],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
                        if os.path.exists(out):
                            with open(out, "rb") as f:
                                jpg = f.read()
                    else:
                        log("表情包转码跳过：没找到 ffmpeg（装到 C:\\ffmpeg 即可）")
                except Exception as e:                # noqa: BLE001
                    log("表情包转码失败：", repr(e))
            if not jpg:
                shot = screenshot_sticker(who)
                if shot:
                    return shot
                return _sticker_label(content)
            ext = "image/png" if jpg[:8] == b"\x89PNG\r\n\x1a\n" else "image/jpeg"
            base = bot_url.rsplit("/webhook", 1)[0]
            r = requests.post(base + "/api/vision",
                              json={"image": base64.b64encode(jpg).decode(), "mime": ext}, timeout=60)
            text = str(r.json().get("text") or "").strip()
            log("表情包识别：", text[:40])
            return text
        except Exception as e:
            log("表情包识别异常：", repr(e))
            return _sticker_label(str(msg.get("content") or ""))

    def on_message_inner(msg, listener):
        try:
            username = msg.get("username") or ""
            if not username:
                return
            mtype = msg.get("type") or ""
            content = (msg.get("content") or "").strip()
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
                desc = describe_sticker(msg)
                if not desc:
                    log("表情包没认出来，先不说话")
                    return
                content = "（对方刚刚新发了一个表情包，内容是：%s）" % desc
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
                r = requests.post(
                    bot_url,
                    json=payload,
                    headers=headers,
                    timeout=120,
                )
                data = r.json()
            except Exception as e:
                log("请求鲸鲸失败：", repr(e))
                return

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
        except Exception as e:
            log("处理消息异常：", repr(e))

    log("开始监听新消息…（Ctrl+C 退出）")
    executor = ThreadPoolExecutor(max_workers=1)

    def on_message(msg, listener):
        # 每条消息丢线程池：发送慢不再阻塞后面消息的接收
        try:
            executor.submit(on_message_inner, msg, listener)
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
                r = requests.get(base + "/api/share?chat=" + urllib.parse.quote(u), timeout=40)
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
                    if u not in active:
                        target = (u, name)
                        break
            except Exception:
                target = None
            if not target:
                log("主动搭话：最近都在聊，这次先不打扰")
                continue
            u, name = target
            try:
                r2 = requests.get(base + "/api/care", params={"chat": u}, timeout=40)
                text = str((r2.json() or {}).get("text") or "").strip()
            except Exception as e:
                log("生成搭话失败：", repr(e))
                continue
            if not text:
                continue
            log("主动搭话 →", name, text[:30])
            ok = send_text(text, name, u)
            if ok is not False:
                save_state({"lastTs": time.time(), "day": today, "count": sent + 1})


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

    def digest_watch():
        last = time.time()
        while True:
            time.sleep(30)
            if DIGEST_MINUTES <= 0 or not MASTER_WXID:
                continue
            if time.time() - last < DIGEST_MINUTES * 60:
                continue
            if AWAY["on"] or away_active() or game_running() or foreground_is_fullscreen():
                continue
            try:
                base = bot_url.rsplit("/webhook", 1)[0]
                r = requests.get(base + "/api/digest", params={"since": int(last * 1000)}, timeout=30)
                data = r.json()
            except Exception as e:
                log("拉取消息汇总失败：", repr(e))
                continue
            if data.get("count") and data.get("text"):
                name = display_name(MASTER_WXID) or "主人"
                log("给主人发消息汇总：%d 条" % data["count"])
                if send_text(data["text"], name, MASTER_WXID, force=True):
                    last = time.time()
            else:
                last = time.time()

    def explain_uia_failure():
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
        hwnd = find_weixin_hwnd()
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
                                # 连续拿不到就重建窗口驱动。
                                # 实测（3.3.2）：桥接启动那一刻微信正好在托盘里（主窗隐藏）时，
                                # gui 会一直定位不到主窗；之后即使把微信拉出来也不会自愈，
                                # 心跳永远报 uia:false。重建一次就好了。
                                misses += 1
                                if misses >= 3:
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
                }
                headers = {"x-whale-bridge": "1"}
                if token:
                    headers["x-bot-token"] = token
                requests.post(base + "/api/bridge/heartbeat", json=payload, headers=headers, timeout=8)
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
    threading.Thread(target=digest_watch, daemon=True).start()
    threading.Thread(target=warmup, daemon=True).start()
    threading.Thread(target=send_watchdog, daemon=True).start()
    threading.Thread(target=battery_watch, daemon=True).start()
    threading.Thread(target=share_watch, daemon=True).start()
    threading.Thread(target=care_watch, daemon=True).start()
    threading.Thread(target=bridge_heartbeat, daemon=True).start()
    threading.Thread(target=listener_watch, daemon=True).start()
    log("已启动。鲸鲸地址：", bot_url)

    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        log("正在退出…")
        listener.stop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
