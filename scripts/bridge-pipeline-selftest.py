#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""消息调度器的自检（不需要微信，也不连服务端）。

用法：
    python scripts/bridge-pipeline-selftest.py
退出码 0 = 全过。

只打印 ASCII，避免 Windows 控制台乱码影响判断。
"""

import os
import sys
import threading
import time

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (os.path.join(_ROOT, "bridge"), _ROOT):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from msg_pipeline import MessagePipeline, MessageBatches, split_runs, mergeable  # noqa: E402

FAILED = []
N = [0]


def check(name, got, want):
    N[0] += 1
    ok = got == want
    print("  %s %-46s %r" % ("ok  " if ok else "FAIL", name, got))
    if not ok:
        FAILED.append("%s: got %r, want %r" % (name, got, want))


def check_true(name, cond, detail=""):
    N[0] += 1
    print("  %s %-46s %s" % ("ok  " if cond else "FAIL", name, detail))
    if not cond:
        FAILED.append("%s %s" % (name, detail))


def test_same_chat_order():
    print("[order] same chat must be serial, FIFO")
    p = MessagePipeline(workers=4)
    seen = []
    lock = threading.Lock()

    def task(i):
        time.sleep(0.02 * (5 - i))       # 故意让先投的慢
        with lock:
            seen.append(i)

    for i in range(5):
        p.submit("chatA", task, i)
    p.close(wait=True)
    check("chatA order", seen, [0, 1, 2, 3, 4])


def test_cross_chat_parallel():
    print("[parallel] different chats should overlap")
    p = MessagePipeline(workers=2)
    t0 = time.time()

    def slow():
        time.sleep(0.30)

    p.submit("A", slow)
    p.submit("B", slow)
    p.close(wait=True)
    elapsed = time.time() - t0
    check_true("two chats 0.30s each finish under 0.55s", elapsed < 0.55,
               "%.2fs" % elapsed)


def test_queue_limit():
    print("[limit] per-chat backlog drops the oldest")
    p = MessagePipeline(workers=1, per_chat_limit=3)
    gate = threading.Event()
    ran = []

    def blocked(i):
        ran.append(i)
        gate.wait(3)

    for i in range(6):
        p.submit("A", blocked, i)
    time.sleep(0.15)          # 让第一条开始跑、其余进队列
    gate.set()
    p.close(wait=True)
    # 第 0 条已经在跑；队列里最多留 3 条 → 最终跑 0 + 最后 3 条
    check("dropped count", p.stats["dropped"], 2)
    check("ran", ran, [0, 3, 4, 5])


def test_exception_does_not_stop():
    print("[error] one bad task must not kill the queue")
    p = MessagePipeline(workers=2)
    done = []

    def boom():
        raise RuntimeError("boom")

    p.submit("A", boom)
    p.submit("A", lambda: done.append("after"))
    p.close(wait=True)
    check("next task still ran", done, ["after"])
    check("error counted", p.stats["errors"], 1)


def test_close():
    print("[close] submit after close returns False")
    p = MessagePipeline(workers=1)
    p.close(wait=True)
    check("closed submit", p.submit("A", lambda: None), False)


def test_status():
    print("[status] counters")
    p = MessagePipeline(workers=2)
    for _ in range(3):
        p.submit("A", lambda: None)
    p.close(wait=True)
    st = p.status()
    check("in", st["in"], 3)
    check("done", st["done"], 3)
    check("workers", st["workers"], 2)


def test_batches_merge():
    print("[batch] same chat bursts into one turn, nothing dropped")
    b = MessageBatches(limit=8)
    check("first push queues a flush", b.push("A", "m1"), True)
    check("second rides the same flush", b.push("A", "m2"), False)
    check("third too", b.push("A", "m3"), False)
    check("one batch keeps all three in order", b.take("A"), ["m1", "m2", "m3"])
    check("dropped", b.stats["dropped"], 0)
    check("batches", b.stats["batches"], 1)
    check("merged", b.stats["merged"], 2)
    check("after take a new push queues again", b.push("A", "m4"), True)
    check("take again", b.take("A"), ["m4"])


def test_batches_overflow():
    print("[batch] flood keeps the newest and counts the loss")
    b = MessageBatches(limit=3)
    for i in range(5):
        b.push("A", i)
    check("dropped", b.stats["dropped"], 2)
    check("kept newest", b.take("A"), [2, 3, 4])


def test_batches_release():
    print("[batch] release lets the next push flush again")
    b = MessageBatches()
    check("push", b.push("A", 1), True)
    b.release("A")
    check("push after release", b.push("A", 2), True)
    check("both kept", b.take("A"), [1, 2])


def test_batches_isolation():
    print("[batch] chats do not share a batch")
    b = MessageBatches()
    check("A flush", b.push("A", "a1"), True)
    check("B flush", b.push("B", "b1"), True)
    check("A2 rides", b.push("A", "a2"), False)
    check("take A", b.take("A"), ["a1", "a2"])
    check("take B", b.take("B"), ["b1"])


def test_split_runs():
    print("[batch] only adjacent messages from the same sender merge")
    msgs = [
        {"sender_username": "a", "content": "1"},
        {"sender_username": "a", "content": "2"},
        {"sender_username": "b", "content": "3"},
        {"sender_username": "a", "content": "4"},
    ]
    check("group sizes", [len(r) for r in split_runs(msgs)], [2, 1, 1])


def test_mergeable():
    print("[batch] only plain text merges")
    check("text+text", mergeable([{"type": "文本"}, {"type": "文本"}]), True)
    check("text+image", mergeable([{"type": "文本"}, {"type": "图片"}]), False)
    check("single", mergeable([{"type": "文本"}]), False)


def main():
    test_same_chat_order()
    test_cross_chat_parallel()
    test_queue_limit()
    test_exception_does_not_stop()
    test_close()
    test_status()
    test_batches_merge()
    test_batches_overflow()
    test_batches_release()
    test_batches_isolation()
    test_split_runs()
    test_mergeable()
    print()
    if FAILED:
        print("FAILED %d/%d" % (len(FAILED), N[0]))
        for f in FAILED:
            print("  -", f)
        return 1
    print("ALL PASS (%d checks)" % N[0])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
