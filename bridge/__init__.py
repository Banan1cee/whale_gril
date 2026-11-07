# -*- coding: utf-8 -*-
"""鲸鲸微信桥接包。

入口：

    python -m bridge
    python examples/wechatauto_bridge.py    # 兼容旧路径的薄壳

运行时已拆成：
- `engine.py`：模块级配置、兼容函数、`main()` 转发；
- `app.py`：`BridgeRuntime` 组合根与生命周期；
- `*_mixin.py`：账号 / 窗口 / 发送 / 接收 / 表情包 / 语音 / 心跳等领域。
详见 `bridge/README.md`。
"""
