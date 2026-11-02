#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""后台通道打字编码的离线单测（不碰微信）。

跑法：python -B tests/test_bg_text_encoding.py
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, 'bridge'))

import bg_sender  # noqa: E402


def test_utf16_bmp_char():
    # 鲸 U+9CB8：一个码元
    assert bg_sender.encode_utf16('鲸') == [0x9CB8]


def test_utf16_ascii():
    assert bg_sender.encode_utf16('A') == [65]
    assert bg_sender.encode_utf16('AB') == [65, 66]


def test_utf16_surrogate_pair_for_emoji():
    # 😀 U+1F600 → 代理对 D83D DE00（4.1 的 GBK 通道会直接丢掉这类字符）
    assert bg_sender.encode_utf16('😀') == [0xD83D, 0xDE00]


def test_utf16_roundtrip():
    text = '鲸鲸测试ABC123，标点：（）【】😀'
    units = bg_sender.encode_utf16(text)
    data = b''.join(int(u).to_bytes(2, 'little') for u in units)
    assert data.decode('utf-16-le') == text


def test_encode_utf16_empty():
    assert bg_sender.encode_utf16('') == []
    assert bg_sender.encode_utf16(None) == []


def test_version_tuple():
    assert bg_sender._version_tuple('4.2.0.9') == (4, 2, 0, 9)
    assert bg_sender._version_tuple('4.1.15.53') == (4, 1, 15, 53)
    assert bg_sender._version_tuple('Weixin') == ()
    assert bg_sender._version_tuple('') == ()


def test_mode_decision_threshold():
    # 4.2 起换 UTF-16；4.1 仍然走 GBK 字节
    assert bg_sender._version_tuple('4.1.15.53') < (4, 2)
    assert bg_sender._version_tuple('4.2.0.9') >= (4, 2)


def test_mode_from_versions_prefers_first_trusted():
    # 微信 4.1.x：第一可信候选就是 4.1 → GBK，不能被后面残留的 4.2 目录带偏
    assert bg_sender._mode_from_versions(['4.1.15.56', '4.2.0.9']) == 'gbk'
    # 微信 4.2.x：exe 版本资源是 4.2 → UTF-16
    assert bg_sender._mode_from_versions(['Weixin', '4.2.0.9', '']) == 'utf16'
    # 全认不出来 = 保持老行为 GBK（由调用方兜底）
    assert bg_sender._mode_from_versions(['Weixin', '', 'x']) == ''


def test_exe_version_missing_file_is_empty():
    # 读不到版本资源时不能抛异常，detect_char_mode 还要继续往下判断
    assert bg_sender._exe_version('') == ''
    assert bg_sender._exe_version('Z:\\definitely-not-here\\Weixin.exe') == ''


def test_gbk_still_available():
    # 老版本分支不能因为这次改动坏掉
    payload, skipped = bg_sender.encode_gbk('鲸鲸')
    assert payload == '鲸鲸'.encode('gbk')
    assert skipped == []


def main():
    tests = [v for k, v in sorted(globals().items()) if k.startswith('test_') and callable(v)]
    for t in tests:
        t()
        print('ok', t.__name__)
    print('全部通过：%d 项' % len(tests))


if __name__ == '__main__':
    main()
