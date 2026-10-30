#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""零焦点发送通道的自检（不需要微信在线，也不发消息）。

只测纯逻辑：GBK 字节流、会话名归一化、名字匹配、坐标打包、reason 枚举。
真正的「能不能发出去」用 `python -m bridge --bg-probe`。

用法：
    python scripts/bg-selftest.py
退出码 0 = 全过。
"""

import os
import sys

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (os.path.join(_ROOT, "bridge"), _ROOT):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import bg_sender  # noqa: E402

FAILED = []
CHECKS = [0]


def check(name, got, want):
    CHECKS[0] += 1
    if got != want:
        FAILED.append("%s: 得到 %r，期望 %r" % (name, got, want))
        print("  x %s -> %r (want %r)" % (name, got, want))
    else:
        print("  ok %s" % name)


def test_gbk():
    print("[gbk] 文档 §4.7 的编码表")
    # 鲸 = BE A8，中 = D6 D0
    payload, skipped = bg_sender.encode_gbk("鲸中")
    check("鲸中 bytes", payload, b"\xbe\xa8\xd6\xd0")
    check("鲸中 skipped", skipped, [])

    payload, skipped = bg_sender.encode_gbk("1")
    check("ascii bytes", payload, b"1")

    # 文档 §6.3：直接发 UTF-16 码点会变成别的字，所以绝不能是 0x9CB8
    payload, _ = bg_sender.encode_gbk("鲸")
    check("鲸 不是 utf-16 低字节", payload, b"\xbe\xa8")

    payload, skipped = bg_sender.encode_gbk("好🚀的")
    check("emoji 被跳过（strip）", payload, "好的".encode("gbk"))
    check("emoji 记进 skipped", skipped, ["🚀"])

    payload, skipped = bg_sender.encode_gbk("好🚀", strip_unencodable=False)
    check("不 strip 时返回 None", payload, None)
    check("不 strip 时仍报 skipped", skipped, ["🚀"])

    check("空串", bg_sender.encode_gbk("")[0], b"")


def test_names():
    print("[name] 会话行归一化 / 相似度")
    check("未读后缀", bg_sender.norm_chat_name("文件传输助手\n[图片]"), "文件传输助手")
    check("括号未读", bg_sender.norm_chat_name("深海鱼塘（12）"), "深海鱼塘")
    check("英文括号未读", bg_sender.norm_chat_name("群聊(3)"), "群聊")
    check("没有后缀", bg_sender.norm_chat_name("阿螈"), "阿螈")
    check("鼠标提示", bg_sender.norm_chat_name("文件传输助手长按鼠标 语音输入"), "文件传输助手")

    check("完全相同", bg_sender.name_score("阿螈", "阿螈"), 0)
    check("成员名集合", bg_sender.name_score("成员甲、成员乙、阿螈", "成员甲、成员乙"), 1)
    check("包含", bg_sender.name_score("深海", "深海鱼塘"), 2)
    check("不像", bg_sender.name_score("阿螈", "文件传输助手"), None)


def test_lparam():
    print("[lparam] 客户区坐标打包（§4.8）")
    s = bg_sender.WeChatSender(0)
    check("(0,0)", s._lparam(0, 0), 0)
    check("(12,34)", s._lparam(12, 34), (34 << 16) | 12)
    check("负坐标截断", s._lparam(-1, 0), 0xFFFF)


def test_constants():
    print("[const] 危险消息必须没有被定义（§4.6）")
    check("没有 WM_ACTIVATE", hasattr(bg_sender, "WM_ACTIVATE"), False)
    check("WM_SETFOCUS", bg_sender.WM_SETFOCUS, 0x0007)
    check("WM_KILLFOCUS", bg_sender.WM_KILLFOCUS, 0x0008)
    check("WM_CHAR", bg_sender.WM_CHAR, 0x0102)
    check("WM_MOUSEMOVE", bg_sender.WM_MOUSEMOVE, 0x0200)


def main():
    test_gbk()
    test_names()
    test_lparam()
    test_constants()
    print()
    if FAILED:
        print("失败 %d 项：" % len(FAILED))
        for f in FAILED:
            print("  -", f)
        return 1
    print("全部通过（%d 项）" % CHECKS[0])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
