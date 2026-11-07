# -*- coding: utf-8 -*-
"""配置读取、服务地址等待与 ffmpeg 查找。

这些函数只依赖「仓库根目录 / config.json 路径 / 本机 HTTP 客户端」，拆出来后
engine.py 不再需要把 ROOT、CONFIG_PATH、LOCAL_HTTP 隐式闭包进每个函数。
"""

import json
import os

from bridge_log import log, log_error, log_warn

ROOT = ""
CONFIG_PATH = ""
LOCAL_HTTP = None


def configure(root, config_path):
    global ROOT, CONFIG_PATH
    ROOT = str(root or "")
    CONFIG_PATH = str(config_path or "")


def set_local_http(client):
    global LOCAL_HTTP
    LOCAL_HTTP = client


def read_config():
    cfg = {}
    if CONFIG_PATH and os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8-sig") as f:
                cfg = json.load(f)
        except Exception as e:
            log_error("读取 config.json 失败（会按默认值跑）：", e)
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
            body = r.json() if r.status_code == 200 else None
            if (isinstance(body, dict) and body.get("ok") is True
                    and body.get("up") is True and body.get("service") == "whale-girl"):
                if waited > 0:
                    log("服务已就绪（等了 %d 秒）" % waited)
                return True
        except Exception:
            pass
        if waited == 0:
            log("等服务起来（最多 %d 秒）…" % timeout)
        _t.sleep(1)
        waited += 1
    log_error("[!] 等了 %d 秒服务还没起来。先在启动器里点「启动」，等状态变成「运行中」再跑桥接。" % timeout)
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
            log("找到 ffmpeg：", exe, "（包里自带，微信图片是 wxgf/HEVC，靠它转 jpg）"
                if exe.lower().startswith(_bundled.lower()) else "（微信图片是 wxgf/HEVC，靠它转 jpg）")
            return True
    log_warn("[!] 没找到 ffmpeg：微信 4.x 的图片多是 wxgf/HEVC，没有它就看不了图。")
    log("    装一个（解压到 C:\\ffmpeg 即可）或把 ffmpeg.exe 放进 runtime\\ffmpeg\\bin")
    return False
