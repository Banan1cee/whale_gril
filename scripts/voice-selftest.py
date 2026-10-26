# -*- coding: utf-8 -*-
"""语音链路自检：数据库 → SILK → WAV → 识别文字。

用法：
    python scripts/voice-selftest.py            # 从最近的语音消息里挑一条
    python scripts/voice-selftest.py 文件.wav    # 直接测一个现成的 wav

前一种需要微信正在运行且本机有语音缓存；后一种只测识别接口。
"""
import io
import json
import os
import sys
import time
import wave

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "examples"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

import wechatauto_bridge as bridge  # noqa: E402


def key_status():
    print("语音识别：model=%s  enabled=%s  key=%s" % (
        bridge.VOICE_MODEL,
        bridge.VOICE_ENABLED,
        ("有（%s…）" % bridge.VOICE_API_KEY[:6]) if bridge.VOICE_API_KEY else "没有",
    ))


def from_wav(path):
    with open(path, "rb") as f:
        data = f.read()
    with wave.open(io.BytesIO(data)) as w:
        seconds = w.getnframes() / float(w.getframerate())
    print("音频：%.1fs，%d 字节" % (seconds, len(data)))
    t0 = time.time()
    text = bridge.asr_transcribe(data, bridge.VOICE_API_KEY, bridge.VOICE_MODEL, bridge.VOICE_BASE_URL, bridge.VOICE_TIMEOUT)
    print("耗时 %.1fs" % (time.time() - t0))
    print("识别结果：", bridge.clean_transcript(text) or "（空）")
    return bool(bridge.clean_transcript(text))


def from_db():
    from wechatauto import MediaDownloader, WeChatDB
    import pysilk

    db = WeChatDB()
    dl = MediaDownloader(db, save_dir=os.path.join(ROOT, "data", "media-cache"))
    picked = 0
    for s in db.get_sessions(40):
        u = s.get("username") or ""
        if not u or u in ("filehelper", "weixin", "medianote"):
            continue
        for m in db.get_messages(u, limit=80):
            if m.get("type") != "语音":
                continue
            picked += 1
            path = dl.download_voice(u, int(m.get("local_id")), shard=m.get("shard"))
            if not path:
                print("这条语音没落盘（微信没缓存），换下一条")
                continue
            pcm = io.BytesIO()
            with open(path, "rb") as f:
                pysilk.decode(f, pcm, bridge.VOICE_SAMPLE_RATE)
            raw = pcm.getvalue()
            seconds = len(raw) / float(bridge.VOICE_SAMPLE_RATE * 2)
            wav_path = os.path.splitext(path)[0] + ".wav"
            with wave.open(wav_path, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(bridge.VOICE_SAMPLE_RATE)
                w.writeframes(raw)
            print("\n样本：%s / local_id=%s（%.1fs）" % (u, m.get("local_id"), seconds))
            return from_wav(wav_path)
    print("没找到可用的语音消息（翻了 %d 条语音）" % picked)
    return False


def main():
    key_status()
    if not bridge.VOICE_ENABLED:
        print("voice.enabled=false，先打开再测")
        return 1
    if not bridge.VOICE_API_KEY:
        print("没有 Key：在 config.json 的 voice.apiKey 填，或在 data/settings.json 里配 apiKey")
        return 1
    ok = from_wav(sys.argv[1]) if len(sys.argv) > 1 else from_db()
    print("\n结果：", "语音链路正常" if ok else "没拿到文字，看上面的日志")
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
