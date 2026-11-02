"""Automatic reply transport selection. No API keys or UI operations in policy code."""
import json
import math
import os
import re
import subprocess
import time
import uuid

REQUEST = re.compile(r"(?:发|来|说|讲|回复)(?:给我|个|一条|一句|句|段|一段|条|一下|点|一段话|个回复|次|一)?\s*语音|用语音(?:回|说|讲)|语音(?:回我|回复|说一句)")
NEGATIVE = re.compile(r"不要|别(?:再)?|不想|不用|不能|怎么|如何|他说|她说|有人说|关闭|取消|[\"“”‘’]")

def requested(text):
    text = str(text or "")
    return len(text) <= 500 and not NEGATIVE.search(text) and bool(REQUEST.search(text))

def settings(root):
    try:
        with open(os.path.join(root, "data", "voice-send.json"), encoding="utf-8-sig") as f:
            value = json.load(f)
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}

def choose(config, incoming, is_group, rng):
    if config.get("Enabled") is not True:
        return False
    if config.get("Groups" if is_group else "Private", True) is not True:
        return False
    if re.search(r"(?:不要|别|不用|不想|取消|关闭).{0,12}语音|语音.{0,8}(?:不要|取消|关闭)|(?:用|只要|只用).{0,3}(?:文字|文本)|(?:文字|文本)回复", str(incoming or "")):
        return False
    if requested(incoming):
        return True
    try:
        chance = float(config.get("Probability", 0))
    except (TypeError, ValueError):
        return False
    return math.isfinite(chance) and 0 < chance <= 100 and rng() < chance / 100

def deliver(root, text, hwnd, prepare, log, allow_foreground=None, cancelled=None, outcome=None):
    """Synthesize first; only touch WeChat once the worker reports ready.

    Return True once recording may have begun, including uncertain results. This
    forbids duplicate text fallback after a possible voice send.
    """
    def check_cancelled():
        if settings(root).get("Enabled") is not True or (cancelled is not None and cancelled()):
            raise RuntimeError("语音测试已取消或实验开关已关闭")

    if settings(root).get("Enabled") is not True or (cancelled is not None and cancelled()):
        if outcome is not None:
            outcome.update(Status="failed", Error="语音发送未启用或已取消")
        return False
    directory = os.path.join(root, "data", "voice-send-jobs")
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, uuid.uuid4().hex + ".json")
    process = None
    released = False
    try:
        with open(path, "x", encoding="utf-8") as f:
            json.dump({"Text": text, "Hwnd": int(hwnd)}, f, ensure_ascii=False)
        process = subprocess.Popen([os.path.join(root, "WhaleLauncher.exe"), "--voice-reply-job", path],
                                   cwd=root, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        deadline = time.monotonic() + 125
        while process.poll() is None and not os.path.exists(path + ".ready"):
            check_cancelled()
            if time.monotonic() > deadline:
                raise TimeoutError("语音合成超时")
            time.sleep(0.1)
        if os.path.exists(path + ".ready") and process.poll() is None:
            check_cancelled()
            current = settings(root)
            if current.get("Enabled") is not True:
                raise RuntimeError("自动语音已关闭")
            chat = prepare()
            if not chat:
                raise RuntimeError("无法确认目标账号或会话")
            check_cancelled()
            if allow_foreground is not None:
                allow_foreground(process.pid)
            else:
                try:
                    import ctypes
                    ctypes.windll.user32.AllowSetForegroundWindow(process.pid)
                except (ImportError, AttributeError):
                    pass
            with open(path + ".go.tmp", "x", encoding="utf-8") as f:
                json.dump({"Chat": chat}, f, ensure_ascii=False)
            os.replace(path + ".go.tmp", path + ".go")
            released = True
            deadline = time.monotonic() + 75
            while process.poll() is None:
                check_cancelled()
                if time.monotonic() > deadline:
                    raise TimeoutError("语音录音发送超时")
                # A bounded wait keeps cancellation responsive without busy polling.
                try:
                    process.wait(timeout=0.1)
                except subprocess.TimeoutExpired:
                    pass
        else:
            process.wait(timeout=2)
        if os.path.exists(path + ".result"):
            with open(path + ".result", encoding="utf-8-sig") as f:
                result = json.load(f)
            status = result.get("Status")
            if outcome is not None:
                outcome.update(Status=status, Error=str(result.get("Error", "")))
            log("自动语音：", status, result.get("Error", ""))
            return status in ("sent_unconfirmed", "uncertain")
        if outcome is not None:
            outcome.update(Status="uncertain" if released else "failed", Error="未收到语音工作进程结果")
        return released  # no result after handing over: do not repeat uncertain sends
    except Exception as exc:
        if outcome is not None:
            outcome.update(Status="uncertain" if released else "failed", Error=str(exc))
        log("自动语音未完成：", type(exc).__name__)
        return released
    finally:
        if process is not None and process.poll() is None:
            # Give the worker a chance to cancel recording before it releases keys.
            try:
                with open(path + ".cancel", "w", encoding="utf-8"):
                    pass
                process.wait(timeout=5)
            except Exception:
                # Never forcibly kill a worker that might be holding recording keys.
                pass
        if process is None or process.poll() is not None:
            for suffix in ("", ".ready", ".go", ".go.tmp", ".result", ".cancel", ".claimed"):
                try:
                    os.remove(path + suffix)
                except OSError:
                    pass
