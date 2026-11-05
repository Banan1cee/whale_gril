"""线程、进程与异步环境下的全局 UI 锁。"""

from __future__ import annotations

import asyncio
import functools
import inspect
import multiprocessing
import threading
from contextlib import asynccontextmanager, contextmanager
from typing import Any, Awaitable, Callable, TypeVar, overload


F = TypeVar("F", bound=Callable[..., Any])
AsyncReturn = TypeVar("AsyncReturn")


class LockManager:
    """提供跨线程/进程/异步的锁。

    ``process_lock``（multiprocessing.Lock）不可重入：同一线程内嵌套
    ``acquire`` 会永久阻塞。因此用线程局部计数实现**同线程重入**——同一
    线程重复获取时跳过进程锁（只需重入线程锁），保证
    ``@uilock`` 修饰的函数互相调用（如 ``Chat.ForwardVoiceMessage``
    内部调用 ``VoiceMessage.forward_to``）不会死锁。
    """

    process_lock = multiprocessing.Lock()
    thread_lock = threading.RLock()
    _async_lock: asyncio.Lock | None = None
    _local = threading.local()

    @classmethod
    def _get_async_lock(cls) -> asyncio.Lock:
        """返回与当前事件循环绑定的 ``asyncio.Lock``。"""

        loop = None
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            pass

        lock = cls._async_lock
        if lock is None or (loop and getattr(lock, "_loop", loop) is not loop):
            lock = asyncio.Lock()
            cls._async_lock = lock
        return lock

    @classmethod
    @contextmanager
    def acquire(cls):
        """同步环境下获取锁（同线程可重入）。"""

        depth = getattr(cls._local, "depth", 0)
        if depth > 0:
            # 同线程嵌套：进程锁已被本线程持有，跳过它，只重入线程锁
            with cls.thread_lock:
                cls._local.depth = depth + 1
                try:
                    yield
                finally:
                    cls._local.depth = depth
            return
        with cls.process_lock:
            with cls.thread_lock:
                cls._local.depth = 1
                try:
                    yield
                finally:
                    cls._local.depth = 0

    @classmethod
    @asynccontextmanager
    async def acquire_async(cls):
        """异步环境下获取锁（同线程可重入）。"""

        depth = getattr(cls._local, "depth", 0)
        if depth > 0:
            async with cls._get_async_lock():
                with cls.thread_lock:
                    cls._local.depth = depth + 1
                    try:
                        yield
                    finally:
                        cls._local.depth = depth
            return
        async with cls._get_async_lock():
            with cls.process_lock:
                with cls.thread_lock:
                    cls._local.depth = 1
                    try:
                        yield
                    finally:
                        cls._local.depth = 0


@overload
def uilock(func: Callable[..., Awaitable[AsyncReturn]]) -> Callable[..., Awaitable[AsyncReturn]]:
    ...


@overload
def uilock(func: F) -> F:
    ...


def uilock(func: F):  # type: ignore[misc]
    """确保 UI 自动化操作串行执行的装饰器。"""

    if inspect.iscoroutinefunction(func):

        @functools.wraps(func)
        async def async_wrapper(*args: Any, **kwargs: Any):
            async with LockManager.acquire_async():
                return await func(*args, **kwargs)

        return async_wrapper

    @functools.wraps(func)
    def sync_wrapper(*args: Any, **kwargs: Any):
        with LockManager.acquire():
            return func(*args, **kwargs)

    return sync_wrapper  # type: ignore[return-value]


__all__ = ["LockManager", "uilock"]
