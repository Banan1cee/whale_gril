"""Local, one-shot voice test requests. The target and text are never caller-controlled."""
import json
import math
from pathlib import Path
import re
import time

import voice_reply

TEXT = "哈喽哈喽，可以听见我说话么"


def process_pending(root, send):
    directory = Path(root) / "data" / "voice-send-tests"
    if not directory.is_dir():
        return
    for request in sorted(directory.glob("*.json"))[:10]:
        if not re.fullmatch(r"[a-f0-9]{32}\.json", request.name):
            continue
        path = request.with_suffix("")
        claimed = path.with_suffix(".claimed")
        try:
            # Claim before waiting for the shared send lock; never replay on restart.
            request.rename(claimed)
        except OSError:
            continue
        result = {"Status": "failed", "Error": "账号窗口或目标会话未就绪，请检查桥接状态"}

        def cancelled():
            return path.with_suffix(".cancel").exists() or voice_reply.settings(root).get("Enabled") is not True

        try:
            value = json.loads(claimed.read_text(encoding="utf-8-sig")) if claimed.stat().st_size <= 4096 else {}
            created = value.get("CreatedAt") if isinstance(value, dict) else None
            if not isinstance(created, (int, float)) or not math.isfinite(created) or not 0 <= time.time() * 1000 - created <= 30000:
                result["Error"] = "测试请求已过期，请重新点击测试"
            elif cancelled():
                result["Error"] = "语音测试已取消或实验开关已关闭"
            else:
                send(TEXT, "文件传输助手", "filehelper", cancelled=cancelled, outcome=result)
        except Exception as exc:
            result["Error"] = "语音测试异常：" + type(exc).__name__
        finally:
            temp = path.with_suffix(".result.tmp")
            temp.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
            temp.replace(path.with_suffix(".result"))
            try:
                claimed.unlink()
            except OSError:
                pass
