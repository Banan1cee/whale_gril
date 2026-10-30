"""把 digest_worker.DigestWorker 接到桥接现有的配置 / 联系人 / 发送能力上。

这一层只做适配，不复制调度逻辑：

  - fetch   → GET 本机 ``/api/digest``（开关、代际、重试、放弃都由 worker 决定）
  - resolve → 调桥接传入的解析函数；解析不出唯一会话就返回 ``''``（fail closed）
  - send    → 调桥接现有的 send_text；真正落键前再调一次 ``guard()``

调度、重试上限、开关/代际复核、发送窗口推进都在 ``digest_worker.py`` 里。
"""
import threading


try:                                     # 包方式：python -m bridge
    from .digest_worker import DigestWorker
except ImportError:                      # 脚本方式：bridge/ 在 sys.path 上
    from digest_worker import DigestWorker


DIGEST_TIMEOUT = 15.0


class DigestBridge:
    """构造 worker 并注入桥接依赖；不自己起线程、不自己读 config 文件。"""

    def __init__(self, *, read_config, base_url, http_get, resolve_recipient,
                 send_text, can_send, account, log=None, timeout=DIGEST_TIMEOUT):
        self.base_url = str(base_url or "").rstrip("/")
        self.http_get = http_get
        self.resolve_recipient = resolve_recipient
        self.send_text = send_text
        self.log = log or (lambda *args: None)
        self.timeout = timeout
        self.worker = DigestWorker(
            read_config=read_config,
            fetch=self.fetch,
            resolve_recipient=self.resolve,
            send=self.send,
            can_send=can_send,
            account=str(account or "").strip(),
        )

    # -- DigestWorker 的依赖 -------------------------------------------------
    def fetch(self, params):
        """GET /api/digest；非 200 或非 JSON 对象一律抛异常（worker 自己算重试）。"""
        params = dict(params or {})
        query = {}
        if params.get("check"):
            query["check"] = 1
            query["generation"] = str(params.get("generation") or "")
        else:
            query["since"] = int(params.get("since") or 0)
            if params.get("until") is not None:
                query["until"] = int(params["until"])
            query["maxItems"] = int(params.get("maxItems") or 120)
        response = self.http_get(self.base_url + "/api/digest", params=query,
                                 timeout=self.timeout)
        status = getattr(response, "status_code", 0)
        if status != 200:
            raise RuntimeError("digest HTTP %s" % status)
        data = response.json()
        if not isinstance(data, dict):
            raise ValueError("digest response is not a JSON object")
        return data

    def resolve(self, wxid):
        try:
            target = self.resolve_recipient(wxid)
        except Exception:
            return ""
        return target or ""

    def send(self, text, target, guard):
        """target = (canonical_wxid, 显示名)，由桥接的 resolve 提供。"""
        try:
            canonical, shown = target
        except Exception:
            return False
        if not callable(guard) or not guard():
            return False
        # send_text 支持 send_guard：它会在 send_lock 内、真正落键前再复核一次。
        return bool(self.send_text(text, shown, canonical, send_guard=guard))


def start_worker(bridge, log=None):
    """起 worker 的 daemon 线程；返回线程（停止用 bridge.worker.stop()）。"""
    def _run():
        try:
            bridge.worker.run()
        except Exception as exc:          # noqa: BLE001
            if log is not None:
                log("消息汇总线程退出：", repr(exc))

    thread = threading.Thread(target=_run, name="digest", daemon=True)
    thread.start()
    return thread
