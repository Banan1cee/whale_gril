"""Automatic reply transport selection. No API keys or UI operations in policy code."""
import json
import math
import os
import re
import subprocess
import time
import uuid
import threading
from contextlib import ExitStack, contextmanager

_health_lock = threading.Lock()
_health = {}  # Per installation, in memory only. Never stores text or credentials.

def synth_timeout(config):
    try:
        value = float(config.get("SynthTimeoutSec", 20))
        return max(5.0, min(90.0, value)) if math.isfinite(value) else 20.0
    except (TypeError, ValueError):
        return 20.0

def _health_update(root, failed):
    with _health_lock:
        failures, until = _health.get(root, (0, 0))
        failures = failures + 1 if failed else 0
        _health[root] = (failures, time.monotonic() + 300 if failures >= 2 else 0)

@contextmanager
def _send_slot(lock, check):
    if lock is None:
        yield
        return
    deadline = time.monotonic() + 15
    while not lock.acquire(timeout=0.1):
        check()
        if time.monotonic() >= deadline:
            raise TimeoutError("等待微信发送通道超时，尚未开始录音")
    try:
        check()
        yield
    finally:
        lock.release()

REQUEST = re.compile(r"(?:发|来|说|讲|回复)(?:给我|个|一条|一句|句|段|一段|条|一下|点|一段话|个回复|次|一)?\s*语音|用语音(?:回|说|讲)|语音(?:回我|回复|说一句)")
NEGATIVE = re.compile(r"不要|别(?:再)?|不想|不用|不能|怎么|如何|他说|她说|有人说|关闭|取消|[\"“”‘’]")

def requested(text):
    text = str(text or "")
    return len(text) <= 500 and not NEGATIVE.search(text) and bool(REQUEST.search(text))

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

def deliver(root, text, hwnd, prepare, log, allow_foreground=None, cancelled=None, outcome=None, send_lock=None):
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
    with _health_lock:
        remaining = _health.get(root, (0, 0))[1] - time.monotonic()
    if remaining > 0:
        log("自动语音：接口连续异常，冷却中，回退文字；剩余 %.0fs" % remaining)
        if outcome is not None:
            outcome.update(Status="failed", Error="语音接口连续异常，暂时回退文字，5 分钟后自动再试")
        return False
    directory = os.path.join(root, "data", "voice-send-jobs")
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, uuid.uuid4().hex + ".json")
    process = None
    released = False
    synthesized = False
    started = time.monotonic()
    stage = "合成"
    slots = ExitStack()
    try:
        with open(path, "x", encoding="utf-8") as f:
            json.dump({"Text": text, "Hwnd": int(hwnd)}, f, ensure_ascii=False)
        process = subprocess.Popen([os.path.join(root, "WhaleLauncher.exe"), "--voice-reply-job", path],
                                   cwd=root, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        limit = synth_timeout(settings(root))
        deadline = time.monotonic() + limit
        while process.poll() is None and not os.path.exists(path + ".ready"):
            check_cancelled()
            if time.monotonic() > deadline:
                raise TimeoutError("语音合成超时（%.0fs），尚未开始录音" % limit)
            time.sleep(0.1)
        if os.path.exists(path + ".ready") and process.poll() is None:
            synthesized = True
            _health_update(root, False)
            log("自动语音：合成准备 %.1fs（含工作进程启动与音频下载）" % (time.monotonic() - started))
            stage = "等待发送通道"
            slots.enter_context(_send_slot(send_lock, check_cancelled))
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
            stage = "录音发送"
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
            if not synthesized and result.get("ErrorKind") in ("timeout", "network", "http"):
                _health_update(root, True)
            if "RequestMs" in result:
                log("自动语音接口：HTTP=%s 首响应=%sms 总耗时=%sms" % (
                    result.get("HttpStatus", "-"), result.get("HeadersMs", "-"), result["RequestMs"]))
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
        if stage == "合成" and isinstance(exc, TimeoutError):
            _health_update(root, True)
        log("自动语音未完成：阶段=%s 耗时=%.1fs 原因=%s" % (stage, time.monotonic() - started, str(exc)))
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
        slots.close()
