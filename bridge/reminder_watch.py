"""提醒的准点调度器（桥接侧）。

为什么不用轮询：用户要求「必须准点」。桥接每轮问服务端「有哪些到点的 + 下一条什么时候到」，
然后睡到那个时刻（不是固定 10 秒）。新提醒进来时由 Event 提前唤醒重算。

分工：
  - 服务端负责状态（pending / retrying / done / failed / expired）和「过点不补发」；
  - 这里只负责：到点 → 让微信发出去 → 回执。发送失败的重试由服务端在 5 分钟后
    重新放出来（本模块不自己计时重试，避免两边各算一套）。
"""
import threading


class ReminderRunner:
    def __init__(self, *, fetch, send, ack, now_ms=None, log=None, idle_wait=30.0,
                 max_sleep=60.0, wake=None):
        """依赖全部注入，方便单测（不见网络、不见微信）。"""
        import time as _time
        self.fetch = fetch
        self.send = send
        self.ack = ack
        self.now_ms = now_ms or (lambda: int(_time.time() * 1000))
        self.log = log or (lambda *args: None)
        self.idle_wait = float(idle_wait)
        self.max_sleep = float(max_sleep)
        self.wake = wake or threading.Event()
        self.stopped = False
        self.sent = 0
        self.failed = 0

    def kick(self):
        """有新提醒时提前唤醒（engine 的 config_watch 或其它线程可以调）。"""
        self.wake.set()

    def step(self):
        """问一次，把到点的都发掉。返回 (发了几个, 下一条的时间戳)。"""
        data = self.fetch() or {}
        items = data.get("items") or []
        next_at = int(data.get("nextDueAt") or 0)
        sent = failed = 0
        for item in items:
            if self.stopped:
                break
            text = str(item.get("text") or "").strip()
            if not text:
                self.ack(item, False, "提醒内容为空")
                failed += 1
                continue
            try:
                ok = bool(self.send(item, text))
                err = "" if ok else "微信发送失败"
            except Exception as exc:                      # noqa: BLE001
                ok = False
                err = repr(exc)
            if ok:
                sent += 1
                self.sent += 1
            else:
                failed += 1
                self.failed += 1
            self.ack(item, ok, err)
            if not ok:
                self.log("提醒发送失败（服务端会在 5 分钟后重试一次）：", text[:30], err)
        return sent, next_at

    def run(self):
        while not self.stopped:
            try:
                _, next_at = self.step()
            except Exception as exc:                      # noqa: BLE001
                self.log("提醒调度出错（不影响其它功能）：", repr(exc))
                next_at = 0
            # 睡到下一个提醒时刻（最多 60 秒醒一次，好让「新提醒 / 退出」能及时生效）
            delay = self.idle_wait
            if next_at:
                delay = max(0.2, min(self.max_sleep, (next_at - self.now_ms()) / 1000.0))
            self.wake.wait(delay)
            self.wake.clear()

    def stop(self):
        self.stopped = True
        self.wake.set()
