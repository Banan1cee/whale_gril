"""Bounded, fail-closed digest scheduler. No imports of WeChat/UI/network clients.

The bridge's existing config watcher wakes this worker. OFF has no timer, HTTP
polls, contact lookups or send work. All dependencies are injected for mock tests.
"""
import math
import threading
import time


def _on(value):
    return value is True or (isinstance(value, (str, int, float))
                            and str(value).strip().lower() in {'1', 'true', 'yes', 'on', '开'})


def _bounded(value, default, low, high):
    try:
        number = float(value)
        if not math.isfinite(number):
            return default
        return max(low, min(high, number))
    except (ValueError, TypeError, OverflowError):
        return default


def settings(config):
    """Only digest.enabled is authority; legacy features.digest is ignored."""
    try:
        digest = config.get('digest') or {}
        master = (config.get('persona') or {}).get('master') or {}
        raw = master.get('wxids') or []
        ids = {item.strip() for item in raw if isinstance(item, str) and item.strip()} if isinstance(raw, list) else set()
        recipient = next(iter(ids)) if len(ids) == 1 else ''
        if recipient.endswith('@chatroom') or recipient.startswith('gh_') or recipient in {'filehelper', '文件传输助手'}:
            recipient = ''
        return (_on(digest.get('enabled', False)),
                _bounded(digest.get('everyMinutes', 30), 30, 1, 1440) * 60,
                int(_bounded(digest.get('maxItems', 120), 120, 1, 120)),
                recipient, str((config.get('wechat') or {}).get('account') or '').strip())
    except (AttributeError, TypeError):
        return (False, 1800, 120, '', '')


def guarded_text_once(uia, text, *, gate, valid, read_input, focused, quarantine):
    """One paste/Enter with a gate BETWEEN them; never clean up by sending keys.

    A cancelled paste can leave private text in the input. The bridge quarantines
    that canonical chat before touching it, so later ordinary sends cannot leak
    the draft after OFF. Unknown/partial state is deliberately not retried.
    """
    def same(value):
        return (isinstance(value, str)
                and value.replace('\r\n', '\n').strip() == text.replace('\r\n', '\n').strip())

    try:
        if not gate() or not valid():
            return False
        before = read_input()
        if not isinstance(before, str) or before.strip():
            return False
        control = uia._chat_input()
        if control is None or not callable(getattr(uia, '_paste_into', None)):
            return False
        quarantine(False)
        try:
            # No clearing someone's draft, no send_text() internal unconditional
            # Enter, no OCR/keyboard fallback and no content-similarity threshold.
            uia._paste_into(control, text, clear=False)
        finally:
            pasted = read_input()
            if isinstance(pasted, str) and pasted.strip():
                quarantine(True)
        if not same(pasted) or not gate():
            return False
        # gate() may wait on network: reprove focus, target, account and full text
        # after it completes, immediately before the only irreversible action.
        if not valid() or not focused(control) or not same(read_input()):
            return False
        control.SendKeys('{Enter}', waitTime=0.05)
        return True
    except Exception:
        return False


class DigestWorker:
    MAX_FETCH_ATTEMPTS = 3

    def __init__(self, *, read_config, fetch, resolve_recipient, send, can_send,
                 account, wall=time.time, monotonic=time.monotonic):
        self.read_config = read_config
        self.fetch = fetch
        self.resolve_recipient = resolve_recipient
        self.send = send
        self.can_send = can_send
        self.account = account
        self.wall = wall
        self.monotonic = monotonic
        self.wake = threading.Event()
        self.lock = threading.RLock()
        self.config = None
        self.version = 0
        self.cursor = int(wall() * 1000)
        self.due = monotonic()
        self.window = None
        self.attempts = 0
        self.stopped = False

    def configure(self, config):
        current = settings(config)
        with self.lock:
            previous = self.config
            if current == previous:
                return
            self.config = current
            # New permissions/recipient/account start a fresh collection window.
            # Frequency/item-limit edits do not change send authority or rewind
            # an in-flight window that may already have reached the recipient.
            if previous is None or (current[0], current[3:]) != (previous[0], previous[3:]):
                self.version += 1
                self.cursor = int(self.wall() * 1000)
            self.window = None
            self.attempts = 0
            self.due = self.monotonic() + current[1]
        self.wake.set()

    def _fresh(self, version):
        try:
            self.configure(self.read_config())
        except Exception:
            self.configure({})
        with self.lock:
            cfg = self.config
            return bool(version == self.version and cfg and cfg[0] and cfg[3]
                        and cfg[4] == self.account and not self.stopped)

    def _finish(self, version, until):
        with self.lock:
            if version == self.version:
                self.cursor = max(self.cursor, until)
                self.window = None
                self.attempts = 0
                self.due = self.monotonic() + self.config[1]

    def step(self):
        """One scheduled bounded window; never retry a potentially sent message."""
        try:
            self.configure(self.read_config())
        except Exception:
            self.configure({})
        with self.lock:
            cfg, version = self.config, self.version
            if (not cfg or not cfg[0] or not cfg[3] or cfg[4] != self.account
                    or self.stopped or self.monotonic() < self.due):
                return
            if self.window is None:
                self.window = (self.cursor, int(self.wall() * 1000))
            since, until = self.window
            # Never tight-loop if fullscreen/account/recipient evidence is missing.
            self.due = self.monotonic() + cfg[1]
        try:
            if not self.can_send() or not self._fresh(version):
                self._finish(version, until)
                return
            target = self.resolve_recipient(cfg[3])
            if not target or not self._fresh(version):
                self._finish(version, until)
                return
            data = self.fetch({'since': since, 'until': until, 'maxItems': cfg[2]})
            if not self._fresh(version):
                return
            if (not isinstance(data, dict) or data.get('ok') is not True
                    or not isinstance(data.get('generation'), str) or not data['generation']
                    or type(data.get('until')) is not int or not since <= data['until'] <= until
                    or type(data.get('count')) is not int or data['count'] < 0
                    or not isinstance(data.get('text'), str)):
                raise ValueError('invalid digest response')
        except Exception:
            with self.lock:
                if version == self.version:
                    self.attempts += 1
                    if self.attempts < self.MAX_FETCH_ATTEMPTS:
                        self.due = self.monotonic() + 30 * self.attempts
                    else:
                        self._finish(version, until)
            return

        generation = data['generation']

        def guard():
            # Called again UNDER send_lock and immediately before UIA send.
            # An OFF disk read forbids even the generation-check HTTP request.
            if not self._fresh(version) or not self.can_send():
                return False
            try:
                if self.resolve_recipient(cfg[3]) != target or not self._fresh(version):
                    return False
                status = self.fetch({'check': 1, 'generation': generation})
                return bool(isinstance(status, dict) and status.get('ok') is True
                            and status.get('enabled') is True and status.get('generation') == generation
                            and self._fresh(version) and self.can_send())
            except Exception:
                return False

        try:
            if data['count'] and data['text'].strip() and guard():
                # Failure/exception may mean delivery happened: discard this window,
                # don't replay it later and don't persist any message text locally.
                self.send(data['text'], target, guard)
        finally:
            self._finish(version, data['until'])

    def run(self):
        while not self.stopped:
            with self.lock:
                cfg = self.config
                delay = (max(0.1, self.due - self.monotonic())
                         if cfg and cfg[0] and cfg[3] and cfg[4] == self.account else None)
            self.wake.wait(delay)
            self.wake.clear()
            if not self.stopped:
                try:
                    self.step()
                except Exception:
                    # A send exception is not permission to replay or kill the worker.
                    pass

    def stop(self):
        self.stopped = True
        self.wake.set()
