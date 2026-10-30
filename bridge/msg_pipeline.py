# -*- coding: utf-8 -*-
"""消息调度：**按会话串行、跨会话并发**。

从 `engine.py` 里拆出来的第一块（见 `bridge/README.md` 的拆分计划）。

为什么需要：旧实现是 `ThreadPoolExecutor(max_workers=1)`，所有消息挤一条队。
群里连发 3 张长截图时，第一张的 OCR 要几分钟，后面全堵着 —— 收消息、识别图片、
等模型、发送全串在一条线上。

三条规则：

1. **同一个会话必须串行**。否则两条消息并发调模型，回复顺序会乱，
   还会抢着写同一个会话的上下文。
2. **跨会话可以并发**。不同人的消息互不相干。
3. **发送不由这里管**。`send_text` 内部有 `send_lock`，UIA 操作天然只能
   一个线程碰，所以发送永远是串行的。

实现：固定大小线程池 + 每个会话一条 FIFO。只有队首那条真正占线程，
后面排队的不会白占 worker（否则 4 个慢会话就能把池子占满）。

这个文件不依赖 wechatauto / win32，可以单独跑
`python scripts/bridge-pipeline-selftest.py` 验证。
"""

import threading
from concurrent.futures import ThreadPoolExecutor


class MessagePipeline:
    def __init__(self, workers=4, per_chat_limit=4, log=None, name="whale-decider"):
        self.workers = max(1, int(workers))
        self.per_chat_limit = max(1, int(per_chat_limit))
        self.log = log or (lambda *a: None)
        self._pool = ThreadPoolExecutor(max_workers=self.workers, thread_name_prefix=name)
        self._guard = threading.Lock()
        self._queues = {}          # chat -> [(fn, args)]
        self._running = set()      # 正在被处理的会话
        self._closed = False
        self.stats = {"in": 0, "done": 0, "dropped": 0, "errors": 0, "peak_queue": 0}

    def submit(self, chat, fn, *args):
        """投递一条任务。返回 False 表示已经 close。"""
        chat = chat or "_"
        with self._guard:
            if self._closed:
                return False
            self.stats["in"] += 1
            q = self._queues.setdefault(chat, [])
            q.append((fn, args))
            if len(q) > self.per_chat_limit:
                # 同一会话积压太多：丢最旧的。那条多半已经过期了
                # （服务端还有 STALE_AFTER 兜底），留着只会让她回上一句。
                q.pop(0)
                self.stats["dropped"] += 1
                self.log("会话积压超过 %d 条，丢掉最早的一条：%s"
                         % (self.per_chat_limit, chat))
            if len(q) > self.stats["peak_queue"]:
                self.stats["peak_queue"] = len(q)
            if chat in self._running:
                return True
            self._running.add(chat)
        self._pool.submit(self._drain, chat)
        return True

    def _drain(self, chat):
        while True:
            with self._guard:
                q = self._queues.get(chat)
                if not q:
                    self._running.discard(chat)
                    self._queues.pop(chat, None)
                    return
                fn, args = q.pop(0)
            try:
                fn(*args)
                with self._guard:
                    self.stats["done"] += 1
            except Exception as e:                 # noqa: BLE001
                with self._guard:
                    self.stats["errors"] += 1
                self.log("处理消息异常：", repr(e))

    def status(self):
        with self._guard:
            return dict(
                self.stats,
                running=len(self._running),
                queued=sum(len(v) for v in self._queues.values()),
                workers=self.workers,
            )

    def close(self, wait=True):
        with self._guard:
            self._closed = True
        self._pool.shutdown(wait=wait)
