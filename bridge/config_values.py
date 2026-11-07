# -*- coding: utf-8 -*-
"""配置值解析：纯函数，不读写全局状态。

engine.py 启动时要把 config.json 里大量「可能是字符串、可能是数字、可能是坏值」
的字段收敛成稳定类型。以前这些 helper 混在 4000 多行的 engine.py 里，既不好测，
也容易被后面的闭包误用。挪到这里后：

- 所有转换都只依赖入参，坏值给默认值，绝不抛异常；
- `parse_bg_send` 只把 `wechat.bgSend` 收敛成固定结构，真正的发送仍由
  `bg_sender.py` / engine 的闭包负责。
"""


def as_bool(value, default=False):
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


def as_int(value, default=0):
    """配置里的整数：写成 "123" 也认，坏值给默认值（M12）。"""
    try:
        return int(value)
    except Exception:
        try:
            return int(float(value))
        except Exception:
            return default


def as_float(value, default=0.0):
    """配置里的小数：坏值给默认值，绝不让一个字段炸掉整段解析（M12）。"""
    try:
        return float(value)
    except Exception:
        return default


def parse_bg_send(wechat_cfg):
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
        "enabled": as_bool(raw.get("enabled", True), True),
        # 文档 §4.7：字节间隔 ≤45ms，太短会丢字；给个 20~80 的安全区间
        "charGap": _num("charGapMs", 40, 20, 80) / 1000.0,
        # 发完回读输入框是否清空；关掉能省 ~0.5s，但少了「真发出去」的证据
        "verify": as_bool(raw.get("verify", True), True),
        # 后台通道失败时要不要退回会抢前台的旧通道
        "fallback": as_bool(raw.get("fallbackToForeground", True), True),
        # GBK 编不了的字符（emoji 等）是跳过还是整条退回旧通道
        "strip": as_bool(raw.get("stripUnencodable", True), True),
        # 微信缩在托盘里（窗口隐藏）时，用「显示但不激活」把它拉出来 —— 不抢前台
        "unhide": as_bool(raw.get("unhideWindow", True), True),
        # WM_CHAR 的编码语义：auto = 按微信版本自动（4.2+ 用 UTF-16 码元）
        "charMode": str(raw.get("charMode") or "auto").lower(),
        # 后台通道的固定等待（秒）：缺省用 bg_sender.TIMING 的线上实测值，
        # 这里只透传用户覆盖的那部分，让「想快一点」不用改代码。
        "timing": raw.get("timing") if isinstance(raw.get("timing"), dict) else {},
    }
