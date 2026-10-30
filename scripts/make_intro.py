# -*- coding: utf-8 -*-
"""鲸鲸介绍片生成器：PIL 逐帧渲染 + Windows 中文 TTS + ffmpeg 合成。

用法：
    python scripts/make_intro.py            # 生成 1280x720 成片
    python scripts/make_intro.py --hd       # 1920x1080（更慢）

输出：
    release/intro/鲸鲸介绍.mp4
    release/intro/cover.png   （B站封面 1146x717）
"""
import json
import math
import os
import random
import subprocess
import sys
import tempfile
import wave

import numpy as np
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "release", "intro")
TMP = os.path.join(tempfile.gettempdir(), "whale-intro")
FPS = 30
FONT = r"C:\Windows\Fonts\msyh.ttc"
FONT_BOLD = r"C:\Windows\Fonts\msyhbd.ttc"
CYAN = (87, 214, 255)
WHITE = (232, 246, 255)
DIM = (150, 190, 215)

# 每一幕：旁白 + 画面
SCENES = [
    {"voice": "她叫鲸鲸，一个从深海爬上来的鲸鱼娘。", "title": "鲸鲸", "sub": "从深海爬上来的鲸鱼娘", "kind": "title"},
    {"voice": "蓝头发，鲸尾发夹，怀里永远抱着一只小蓝鲸。",
     "title": "她是谁", "sub": "深蓝长卷发 · 鲸尾发夹 · 群里那个不太正经的群友", "kind": "text"},
    {"voice": "会聊天，不端着。一句话拆成两三条发，像真人随手打字。",
     "title": "会聊天", "lines": ["今天上班累死了", "累就对了，打工哪有轻松的", "回家先瘫一会儿吧"], "kind": "chat"},
    {"voice": "被骂了也不惯着。贴吧老哥那一套，她张口就来。",
     "title": "会怼人", "lines": ["你个废物", "你骂谁废物呢，我配不配说话轮得到你张嘴", "现实里没人理你，跑群里刷存在感？"], "kind": "fight"},
    {"voice": "看得懂图。截图里的字，她能一条一条读出来。",
     "title": "看得懂图", "lines": ["对方：困了就闭眼", "本人：我在上线性代数课", "对方：矩阵相乘像织布，行列式算面积"], "kind": "chat"},
    {"voice": "也听得懂语音。收到语音先转成文字，再正常接话。",
     "title": "听得懂语音", "lines": ["（语音 3.9 秒）", "哎不是，等会儿兄弟，我可以借个号", "借号？借谁的号"], "kind": "voice"},
    {"voice": "还会记事。你说过的名字、住哪儿、爱吃什么，她记在小本本上。",
     "title": "会记事", "lines": ["我住在杭州，喜欢吃辣", "杭州啊，那可以去龙翔桥试试，辣得够劲", "我住哪来着？——你刚说住杭州，记着呢"], "kind": "chat"},
    {"voice": "背后是真模型在跑。DeepSeek、通义千问、智谱，一句话就能换。",
     "title": "技术栈", "sub": "DeepSeek · 千问 · 智谱视觉 · 微信桥接 · 本地记忆", "kind": "text"},
    {"voice": "她不是客服，是个会闹脾气的群友。B站搜鲸鲸，来看她。",
     "title": "来找她玩", "sub": "一个会怼人的鲸鱼娘 · 可持续调教", "kind": "end"},
]


def voice(text, path):
    """用 Windows 自带中文语音合成一句，返回时长（秒）。"""
    esc = text.replace("'", "''")
    ps = (
        "Add-Type -AssemblyName System.Speech;"
        "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer;"
        "$s.SelectVoice('Microsoft Huihui Desktop');"
        "$s.Rate=0;"
        "$s.SetOutputToWaveFile('%s');"
        "$s.Speak('%s');$s.Dispose()" % (path.replace("'", "''"), esc)
    )
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with wave.open(path) as w:
        return w.getnframes() / float(w.getframerate())


def read_wav(path):
    with wave.open(path) as w:
        rate = w.getframerate()
        n = w.getnframes()
        ch = w.getnchannels()
        raw = w.readframes(n)
    data = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        data = data.reshape(-1, ch).mean(axis=1)
    return rate, data


def bgm(seconds, rate):
    """一段很轻的海底氛围铺底（纯合成，无版权问题）。"""
    t = np.linspace(0, seconds, int(seconds * rate), endpoint=False)
    chords = [(110.0, 164.8, 220.0), (98.0, 146.8, 196.0), (123.5, 185.0, 246.9)]
    out = np.zeros_like(t)
    seg = max(1.0, seconds / len(chords))
    for i, ch in enumerate(chords):
        env = np.clip((t - i * seg) / seg, 0, 1) * np.clip((seconds - t) / seg, 0, 1)
        for f in ch:
            out += np.sin(2 * np.pi * f * t) * 0.09 * env
    out += np.sin(2 * np.pi * 0.12 * t) * 0.02
    return np.clip(out, -1, 1)


def lerp(a, b, k):
    return tuple(int(a[i] + (b[i] - a[i]) * k) for i in range(3))


def bg_image(w, h, seed=7):
    """静态海底背景：渐变 + 光柱 + 气泡，只算一次。"""
    rng = random.Random(seed)
    y = np.linspace(0, 1, h, dtype=np.float32)[:, None]
    top = np.array([4, 18, 31], dtype=np.float32)
    bot = np.array([8, 38, 58], dtype=np.float32)
    grad = top + (bot - top) * y
    arr = np.repeat(grad[:, None, :], w, axis=1)

    x = np.linspace(0, 1, w, dtype=np.float32)[None, :]
    glow = np.exp(-((x - 0.5) ** 2) / 0.08) * np.exp(-((y - 0.35) ** 2) / 0.35)
    arr += glow[..., None] * np.array([12, 40, 60], dtype=np.float32)

    img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    d = ImageDraw.Draw(img, "RGBA")
    # 光柱
    for i in range(5):
        cx = int(w * rng.uniform(0.1, 0.9))
        width = rng.randint(int(w * 0.03), int(w * 0.09))
        d.polygon([(cx, 0), (cx + width, 0), (cx + width * 2, h), (cx - width, h)],
                  fill=(90, 190, 255, 8))
    # 静态气泡
    for _ in range(90):
        bx, by = rng.uniform(0, w), rng.uniform(0, h)
        r = rng.uniform(1.5, 7)
        a = int(rng.uniform(12, 46))
        d.ellipse([bx - r, by - r, bx + r, by + r], outline=(180, 235, 255, a), width=1)
    return img


def draw_whale_tail(d, cx, cy, s, alpha=255):
    """鲸尾剪影：两条尾鳍 + 尾巴。"""
    col = (87, 214, 255, alpha)
    soft = (87, 214, 255, int(alpha * 0.55))
    # 尾柄
    d.line([(cx, cy + s * 0.35), (cx, cy + s * 1.65)], fill=soft, width=max(4, s // 12))
    # 左右尾鳍
    left = [
        (cx - s * 0.12, cy + s * 0.45),
        (cx - s * 0.95, cy - s * 0.35),
        (cx - s * 1.05, cy + s * 0.15),
        (cx - s * 0.35, cy + s * 0.72),
    ]
    right = [(2 * cx - x, y) for (x, y) in left]
    d.polygon(left, fill=col)
    d.polygon(right, fill=col)


def text_center(d, xy, text, font, fill, alpha=255):
    bbox = d.textbbox((0, 0), text, font=font)
    x = xy[0] - (bbox[2] - bbox[0]) / 2
    y = xy[1] - (bbox[3] - bbox[1]) / 2
    d.text((x, y), text, font=font, fill=fill + (alpha,) if len(fill) == 3 else fill)


def wrap(d, text, font, max_w):
    lines, cur = [], ""
    for ch in text:
        if d.textlength(cur + ch, font=font) > max_w:
            lines.append(cur)
            cur = ch
        else:
            cur += ch
    if cur:
        lines.append(cur)
    return lines


def render_frame(bg, size, scene, t_in, dur, fonts, frame_idx):
    """画一帧：背景 + 动态气泡 + 场景内容 + 旁白字幕。"""
    w, h = size
    img = bg.copy()
    d = ImageDraw.Draw(img, "RGBA")
    rng = random.Random(1234 + frame_idx // 3)
    # 上升气泡
    for i in range(26):
        bx = (rng.uniform(0, w) + t_in * rng.uniform(4, 22)) % w
        by = (rng.uniform(0, h) - t_in * rng.uniform(18, 60)) % h
        r = rng.uniform(2, 6)
        d.ellipse([bx - r, by - r, bx + r, by + r], outline=(190, 240, 255, 40), width=1)

    # 出场 / 退场淡入淡出
    fade = min(1.0, t_in / 0.45, max(0.0, (dur - t_in) / 0.45))
    a = int(255 * max(0.0, min(1.0, fade)))
    if a <= 2:
        return img

    kind = scene.get("kind")
    if kind in ("title", "end"):
        draw_whale_tail(d, w // 2, int(h * 0.26), int(h * 0.09), a)
        text_center(d, (w // 2, int(h * 0.46)), scene["title"], fonts["huge"], WHITE, a)
        text_center(d, (w // 2, int(h * 0.60)), scene.get("sub", ""), fonts["mid"], CYAN, a)
        if kind == "end":
            text_center(d, (w // 2, int(h * 0.74)), "B站 / 微信 搜「鲸鲸」", fonts["small"], DIM, a)
    else:
        text_center(d, (w // 2, int(h * 0.15)), scene["title"], fonts["big"], CYAN, a)
        lines = scene.get("lines") or []
        if scene.get("sub"):
            lines = [scene["sub"]]
        f = fonts["mid"]
        total = len(lines)
        step = h * 0.15 if total <= 3 else h * 0.115
        # 纵向居中：整体往上偏一点，给字幕留位置
        base_y = int(h * 0.34)
        for i, line in enumerate(lines):
            appear = max(0.0, min(1.0, (t_in - 0.3 - i * 0.4) / 0.3))
            if appear <= 0:
                continue
            la = int(a * appear)
            # 太长就折成两行
            wrapped = wrap(d, line, f, w * 0.72)
            y = int(base_y + i * step)
            box_w = min(w * 0.82, max(d.textlength(x, font=f) for x in wrapped) + 72)
            box_h = 30 + (len(wrapped) - 1) * (h * 0.055)
            x0 = (w - box_w) / 2
            mine = i % 2 == 1
            fill = (24, 74, 96, int(la * 0.85)) if mine else (18, 52, 74, int(la * 0.85))
            d.rounded_rectangle([x0, y - 22, x0 + box_w, y - 22 + box_h + 26], radius=16, fill=fill,
                                outline=(87, 214, 255, int(la * 0.5)), width=1)
            for j, seg in enumerate(wrapped):
                text_center(d, (w // 2, y + 4 + j * (h * 0.055)), seg, f, WHITE, la)

    # 旁白字幕（底部）
    if scene.get("voice"):
        sub_a = int(a * 0.9)
        text_center(d, (w // 2, int(h * 0.90)), scene["voice"], fonts["small"], (200, 228, 245), sub_a)

    # 底部进度条
    prog = int(w * 0.6 * (frame_idx / max(1, scene["_frames_total"])))
    d.rectangle([w * 0.2, h - 22, w * 0.2 + prog, h - 19], fill=(87, 214, 255, 90))
    return img


def main():
    hd = "--hd" in sys.argv
    W, H = (1920, 1080) if hd else (1280, 720)
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(TMP, exist_ok=True)

    fonts = {
        "huge": ImageFont.truetype(FONT_BOLD, int(H * 0.16)),
        "big": ImageFont.truetype(FONT_BOLD, int(H * 0.072)),
        "mid": ImageFont.truetype(FONT, int(H * 0.036)),
        "small": ImageFont.truetype(FONT, int(H * 0.028)),
    }

    print("① 合成长沙…配音")
    clips = []
    for i, sc in enumerate(SCENES):
        path = os.path.join(TMP, "v%02d.wav" % i)
        if not os.path.exists(path):
            try:
                voice(sc["voice"], path)
            except Exception as e:
                print("TTS 失败：", e)
                return 1
        rate, data = read_wav(path)
        clips.append((rate, data))
        sc["_dur"] = len(data) / float(rate) + 0.55  # 留一点呼吸
    rate = clips[0][0]

    print("② 混音")
    total = sum(sc["_dur"] for sc in SCENES)
    mix = np.zeros(int(total * rate) + rate, dtype=np.float32)
    pos = 0.0
    for sc, (_, data) in zip(SCENES, clips):
        start = int(pos * rate)
        mix[start:start + len(data)] += data * 0.95
        pos += sc["_dur"]
    mix[:len(bgm(total, rate))] += bgm(total, rate) * 0.35
    mix = np.clip(mix, -1, 1)
    narration = os.path.join(TMP, "mix.wav")
    with wave.open(narration, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes((mix * 32767).astype(np.int16).tobytes())

    print("③ 渲染画面（%dx%d，约 %.0f 秒）" % (W, H, total))
    bg = bg_image(W, H)
    out_mp4 = os.path.join(OUT_DIR, "鲸鲸介绍.mp4")
    ff = None
    try:
        import imageio_ffmpeg
        ff = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        ff = "ffmpeg"
    cmd = [ff, "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "%dx%d" % (W, H), "-r", str(FPS), "-i", "-",
           "-i", narration, "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
           "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", out_mp4]
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    frame_idx = 0
    try:
        for sc in SCENES:
            frames = max(1, int(round(sc["_dur"] * FPS)))
            sc["_frames_total"] = frames
            for k in range(frames):
                img = render_frame(bg, (W, H), sc, k / FPS, sc["_dur"], fonts, frame_idx)
                proc.stdin.write(img.tobytes())
                frame_idx += 1
    finally:
        proc.stdin.close()
        proc.wait()

    # 封面
    cover = render_frame(bg, (W, H), dict(SCENES[0], _frames_total=1), 1.2, 4.0, fonts, 30)
    cover_png = os.path.join(OUT_DIR, "cover.png")
    cover.resize((1146, int(1146 * H / W))).save(cover_png)

    size_mb = os.path.getsize(out_mp4) / 1024 / 1024
    print("done: %s (%.1f MB, %.1f s, %d frames)" % (out_mp4, size_mb, total, frame_idx))
    print("cover: %s" % cover_png)
    return 0


if __name__ == "__main__":
    sys.exit(main())
