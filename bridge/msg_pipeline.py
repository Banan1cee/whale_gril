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

上面是「谁来跑」。`MessageBatches` 管的是「跑之前攒什么」：同一会话在
上一轮还没跑完时又来的消息，先攒着，等这轮结束一起处理。这样连发两三条
不会再变成「第一条回完、第二条已经过期被丢掉」。

这个文件不依赖 wechatauto / win32，可以单独跑
`python scripts/bridge-pipeline-selftest.py` 验证。
"""

import threading
import time
from concurrent.futures import ThreadPoolExecutor


def split_runs(items, key="sender_username"):
    """把一批消息按「同一个人连着说」切成若干段。

    同一个群里张三说完李四接着说，不能并成一条 —— 并了就把话算到一个人头上，
    回复也会张冠李戴。只合并「相邻 + 同一发送者」的消息。
    """
    runs = []
    for it in items:
        who = (it or {}).get(key) or ""
        if runs and ((runs[-1][0] or {}).get(key) or "") == who:
            runs[-1].append(it)
        else:
            runs.append([it])
    return runs


def mergeable(messages):
    """这几条能不能合成一次请求：都是纯文本。

    （发送者是否相同由 split_runs 保证；图片/语音的正文是识别结果，
    混在一起会分不清哪句话配哪张图，所以不合并。）
    """
    return len(messages) > 1 and all((m.get("type") or "") == "文本" for m in messages)


class MessageBatches:
    """按会话攒消息：等这个会话的上一轮跑完，再整批交出去。

    为什么需要它：同一会话是串行的。第一条正在生成/发送时，后面连发的几条
    只能排队；旧实现是**出队时**按 `create_time` 判「过期」，于是第二条要等
    10~30 秒才出队，一出队就已经是「过期消息」被丢掉 —— 表现就是
    「连发两三条，她只回第一条」。现在过期只在**收到那一刻**判一次
    （见 engine.on_message），进了这个队列就一定会被处理；同一轮攒下的几条
    合并成一次生成，不会一人一句连回三遍。

    与 MessagePipeline 的分工：本类只管「攒什么」，Pipeline 管「谁来跑、按什么
    顺序跑」。push 返回 True 时，调用方才需要向 Pipeline 投一次 flush。
    """

    def __init__(self, limit=8, log=None):
        self.limit = max(1, int(limit))
        self.log = log or (lambda *a: None)
        self._guard = threading.Lock()
        self._pending = {}          # chat -> [msg]
        self._flush_queued = set()  # 已经排了 flush、还没被 take 的会话
        self.stats = {"in": 0, "batches": 0, "merged": 0, "dropped": 0}

    def push(self, chat, item):
        """攒一条。返回 True 表示这个会话还没有排队的 flush，调用方要投一个。"""
        chat = chat or "_"
        with self._guard:
            q = self._pending.setdefault(chat, [])
            q.append(item)
            self.stats["in"] += 1
            if len(q) > self.limit:
                # 极端刷屏（一轮里攒了几十条）：留最新的，丢最早的，
                # 但要记账 —— 以前是静默丢，用户只知道「她漏回了」。
                q.pop(0)
                self.stats["dropped"] += 1
                self.log("会话 %s 一轮攒了超过 %d 条，丢掉最早的一条" % (chat, self.limit))
            if chat not in self._flush_queued:
                self._flush_queued.add(chat)
                return True
            return False

    def take(self, chat):
        """取走这个会话攒下的全部消息（取走即清空，并把 flush 标记清掉）。

        标记要在**开始处理时**清，不能等处理完：处理期间新来的消息必须能
        再排一次 flush，否则它们会一直躺在待处理里没人管。
        """
        chat = chat or "_"
        with self._guard:
            self._flush_queued.discard(chat)
            items = self._pending.pop(chat, [])
            if items:
                self.stats["batches"] += 1
                self.stats["merged"] += max(0, len(items) - 1)
        return items

    def release(self, chat):
        """放弃「已排 flush」的标记（投递失败时用）。消息仍留在待处理里。"""
        with self._guard:
            self._flush_queued.discard(chat or "_")

    def pending(self, chat):
        with self._guard:
            return len(self._pending.get(chat or "_", []))

    def status(self):
        with self._guard:
            return dict(
                self.stats,
                chats=len(self._pending),
                queued=sum(len(v) for v in self._pending.values()),
            )


class MessagePipeline:
    def __init__(self, workers=4, per_chat_limit=8, log=None, name="whale-decider",
                 drop_log_interval=10.0):
        self.workers = max(1, int(workers))
        self.per_chat_limit = max(1, int(per_chat_limit))
        self.drop_log_interval = max(0.0, float(drop_log_interval))
        self.log = log or (lambda *a: None)
        self._pool = ThreadPoolExecutor(max_workers=self.workers, thread_name_prefix=name)
        self._guard = threading.Lock()
        self._queues = {}          # chat -> [(fn, args)]
        self._running = set()      # 正在被处理的会话
        self._closed = False
        # 积压日志节流：卡住时每条新消息都溢出一次，原样打印就是刷屏。
        self._drop_log_at = {}     # chat -> 上次打日志的时间
        self._drop_count = {}      # chat -> 本窗口内已丢条数
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
                # 同一会话积压太多：丢最旧的。这是安全网 —— 正常情况下走不到：
                # engine 每个会话同时只排一个 flush 任务，消息本身由
                # MessageBatches 攒着，不占这里的队列额度。
                q.pop(0)
                self.stats["dropped"] += 1
                self._drop_count[chat] = self._drop_count.get(chat, 0) + 1
                now = time.time()
                if now - self._drop_log_at.get(chat, 0.0) >= self.drop_log_interval:
                    self._drop_log_at[chat] = now
                    n = self._drop_count.pop(chat, 1)
                    self.log("会话积压超过 %d 条，%.0f 秒内丢掉 %d 条：%s"
                             % (self.per_chat_limit, self.drop_log_interval, n, chat))
            if len(q) > self.stats["peak_queue"]:
                self.stats["peak_queue"] = len(q)
            if chat in self._running:
                return True
            self._running.add(chat)
        # submit 保持在锁外（收进锁内会让 drain 线程晚一步拿到锁、队首被积压上限
        # 挤掉），改用 try/except 挡住与 close() 的竞态（L7）：close() 把 _closed
        # 置真后才 shutdown 线程池，这里撞上「已经关池」时不能把 RuntimeError
        # 抛给消息线程（旧实现会话会永久卡死），而是清掉本会话痕迹、按「已关闭」
        # 语义返回 False。
        try:
            self._pool.submit(self._drain, chat)
        except RuntimeError:
            with self._guard:
                self._running.discard(chat)
                self._queues.pop(chat, None)
                self._closed = True
            self.log("消息调度已关闭，这条没能排上：", chat)
            return False
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
