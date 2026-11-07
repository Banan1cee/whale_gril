# -*- coding: utf-8 -*-
"""本机 HTTP 客户端：每个线程一个 requests.Session。

`requests.Session` 不是线程安全的，而桥接是跨会话并发处理的。共用一个
Session 会出现连接池 / header 串台，所以这里按线程隔离；`trust_env=False`
则是为了不读系统代理（Clash 没开时，连 127.0.0.1 会报积极拒绝）。
"""

import threading

import requests


class ThreadLocalHTTP:
    """接口和 Session 一样（get / post / close），调用方不用改。"""

    trust_env = False

    def __init__(self):
        self._local = threading.local()
        self._all = []
        self._guard = threading.Lock()

    def _session(self):
        s = getattr(self._local, "session", None)
        if s is None:
            s = requests.Session()
            s.trust_env = False          # 本机请求不读系统代理
            self._local.session = s
            with self._guard:
                self._all.append(s)
        return s

    def get(self, *args, **kwargs):
        return self._session().get(*args, **kwargs)

    def post(self, *args, **kwargs):
        return self._session().post(*args, **kwargs)

    def close(self):
        with self._guard:
            for s in self._all:
                try:
                    s.close()
                except Exception:
                    pass
            self._all.clear()
