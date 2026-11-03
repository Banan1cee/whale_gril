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


# ---- 2026-11-03：版本号不可信，auto 模式要实测 WM_CHAR 语义 ----
def test_detect_uses_sniff_for_old_version_and_caches():
    """4.1 版本号只给「候选 GBK」，真值要靠实测：测得 utf16 就用 utf16，并缓存。"""
    saved = (bg_sender._detect_char_mode_by_version, bg_sender.sniff_char_mode,
             bg_sender.find_hwnd)
    calls = []
    try:
        bg_sender._detect_char_mode_by_version = lambda hwnd=0: 'gbk'
        bg_sender.sniff_char_mode = lambda h, log=None: (calls.append(h), 'utf16')[1]
        bg_sender.find_hwnd = lambda: 0
        bg_sender._DETECTED_MODES.clear()
        assert bg_sender.detect_char_mode(123456) == 'utf16'
        assert calls == [123456]
        # 同一窗口第二次直接命中缓存，不再探测
        bg_sender.sniff_char_mode = lambda h, log=None: 'gbk'
        assert bg_sender.detect_char_mode(123456) == 'utf16'
    finally:
        (bg_sender._detect_char_mode_by_version, bg_sender.sniff_char_mode,
         bg_sender.find_hwnd) = saved
        bg_sender._DETECTED_MODES.clear()


def test_detect_without_hwnd_does_not_touch_wechat():
    """hwnd=0 的离线调用（单测/CLI）绝不能去嗅真实微信窗口。"""
    saved = (bg_sender._detect_char_mode_by_version, bg_sender.sniff_char_mode)
    hit = []
    try:
        bg_sender._detect_char_mode_by_version = lambda hwnd=0: 'gbk'
        bg_sender.sniff_char_mode = lambda h, log=None: hit.append(h) or 'utf16'
        bg_sender._DETECTED_MODES.clear()
        assert bg_sender.detect_char_mode(0) == 'gbk'
        assert hit == []
    finally:
        (bg_sender._detect_char_mode_by_version, bg_sender.sniff_char_mode) = saved
        bg_sender._DETECTED_MODES.clear()


def _fake_wechat(mode_that_works):
    """造一个假输入框：只有 mode_that_works 打出来是「鲸」，另一种是乱码。"""
    state = {'text': ''}

    class FakeSender:
        def __init__(self, hwnd):
            self.hwnd = hwnd

        def type_text(self, text, char_gap=0.04, strip_unencodable=True, mode='gbk'):
            state['text'] = text if mode == mode_that_works else '¾¨'
            return True, []

        def _post(self, *a):
            return True

        def end_input(self):
            pass

    class FakeEdit:
        def GetValuePattern(self):
            class _VP:
                def SetValue(_self, v):
                    state['text'] = ''
            return _VP()

    def fake_read_ui(hwnd):
        return {'edit': FakeEdit(), 'value': state['text'], 'nodes': [1] * 170}

    return state, FakeSender, fake_read_ui


def test_sniff_prefers_utf16_when_this_build_uses_utf16():
    saved = (bg_sender.read_ui, bg_sender.WeChatSender, bg_sender.time.sleep)
    _state, sender, read_ui = _fake_wechat('utf16')
    try:
        bg_sender.read_ui = read_ui
        bg_sender.WeChatSender = sender
        bg_sender.time.sleep = lambda s: None
        assert bg_sender.sniff_char_mode(4242) == 'utf16'
        # 探测完输入框必须是空的
        assert bg_sender.read_ui(4242)['value'] == ''
        assert bg_sender._DETECT_DIRTY == []
    finally:
        (bg_sender.read_ui, bg_sender.WeChatSender, bg_sender.time.sleep) = saved
        bg_sender._DETECT_DIRTY.clear()


def test_sniff_falls_back_to_gbk_on_old_build():
    saved = (bg_sender.read_ui, bg_sender.WeChatSender, bg_sender.time.sleep)
    _state, sender, read_ui = _fake_wechat('gbk')
    try:
        bg_sender.read_ui = read_ui
        bg_sender.WeChatSender = sender
        bg_sender.time.sleep = lambda s: None
        assert bg_sender.sniff_char_mode(4243) == 'gbk'
        assert bg_sender.read_ui(4243)['value'] == ''
    finally:
        (bg_sender.read_ui, bg_sender.WeChatSender, bg_sender.time.sleep) = saved
        bg_sender._DETECT_DIRTY.clear()


def test_sniff_refuses_when_composer_has_draft():
    saved = (bg_sender.read_ui, bg_sender.WeChatSender, bg_sender.time.sleep)
    _state, sender, read_ui = _fake_wechat('utf16')
    try:
        bg_sender.read_ui = lambda hwnd: {'edit': object(), 'value': '草稿', 'nodes': [1] * 170}
        bg_sender.WeChatSender = sender
        bg_sender.time.sleep = lambda s: None
        assert bg_sender.sniff_char_mode(4244) == ''   # 有草稿 → 不探测、不清空
    finally:
        (bg_sender.read_ui, bg_sender.WeChatSender, bg_sender.time.sleep) = saved
        bg_sender._DETECT_DIRTY.clear()


def main():
    tests = [v for k, v in sorted(globals().items()) if k.startswith('test_') and callable(v)]
    for t in tests:
        t()
        print('ok', t.__name__)
    print('全部通过：%d 项' % len(tests))


if __name__ == '__main__':
    main()
