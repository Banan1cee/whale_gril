# 微信桥接（Python）模块图

当前状态：`engine.py` 是原 `examples/wechatauto_bridge.py` 的完整迁移，
入口已经拆成 `python -m bridge` / `examples/wechatauto_bridge.py` 薄壳。
`engine.py` 内部的 `main()` 仍然是巨型函数（约 2100 行闭包），下一步按下面的顺序拆：

```
bridge/
├─ __main__.py      # python -m bridge 入口（已完成）
├─ engine.py        # 当前完整实现（待拆）
├─ config.py        # TODO reload_config / read_config / build_bot_url / wait_for_server
├─ wechat_db.py     # TODO looks_like_db_root / resolve_db_dir / find_account_dirs / list_accounts_cli
├─ logging.py       # TODO log / log_throttled / boot / log_window_problem
├─ guards.py        # TODO is_system_notice / duplicate_guard / rate_guard
├─ window.py        # TODO hwnd 探测 / 前台切换 / 窗口状态快照还原
├─ sender.py        # TODO ensure_window / UIA 发送 / OCR 兜底 / 键盘通道
├─ receiver.py      # TODO 数据库轮询 / 消息归一化 / 去重
├─ media.py         # TODO ffmpeg / wxgf 转码 / 媒体缓存
├─ voice.py         # TODO ASR 转写
└─ loop.py          # TODO main 循环 / 心跳 / 守护
```

拆解原则（避免行为漂移）：

1. 先拆无副作用模块：`config` → `wechat_db` → `logging` / `guards`；
2. 再拆有副作用的 `window` / `sender` / `receiver`，**只挪位置、不改函数体**；
3. 每步用 `python -m py_compile` + `scripts/smoke.ps1` + `scripts/mock-gateway.js` 验证；
4. 入口与 HTTP 协议（`/webhook/wechat`、`/api/bridge/heartbeat`）保持不变。
