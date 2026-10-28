"""Fail-closed, one-shot sticker transport. Importing this module does no UI work.

There is deliberately no navigation, visibility/foreground manipulation, OCR,
retry, or dependency on WeChatGUI.send_image. The operator must already have
opened the unique target in the pinned foreground main window and focused its
empty input. Missing UIA evidence means no Enter, not a guessed send.
"""
import hashlib
import json
import os
import re
import stat
import time

MAX_BYTES = 4 * 1024 * 1024
IMAGE_TYPES = {'.gif': 'GIF', '.png': 'PNG', '.jpg': 'JPEG', '.jpeg': 'JPEG', '.webp': 'WEBP'}
MEDIA_TYPES = {'图片', '表情', '动画表情'}


def result(status, error='', draft_may_remain=False, draft_observed=False):
    if status not in {'confirmed', 'unconfirmed', 'failed', 'cancelled'}:
        status = 'failed'
    outcome = {'status': status, 'error': str(error)}
    if draft_may_remain:
        outcome['draft_may_remain'] = True
    if draft_observed:
        outcome['draft_observed'] = True
    return outcome


def is_on(value):
    return value is True or (isinstance(value, (str, int, float))
                            and str(value).strip().lower() in {'1', 'true', 'yes', 'on', '开'})


def read_enabled_config(config_path):
    """Only this config read is permitted while the local master switch is off."""
    try:
        with open(config_path, encoding='utf-8-sig') as stream:
            cfg = json.load(stream)
        return cfg if isinstance(cfg, dict) and is_on((cfg.get('features') or {}).get('stickers')) else None
    except Exception:
        return None


def _verify_image(path, expected):
    from PIL import Image
    with Image.open(path) as image:
        if image.format != expected or image.width * image.height > 16000000:
            raise ValueError('unsupported image')
        image.verify()


def validate_path(path, root, image_check=None):
    """Reject escapes, reparse points/symlinks, nonimages and changed files.

    Returns a fingerprint for revalidation before paste. Paths/errors are never
    echoed to the result (a job can originate in an untrusted webhook response).
    """
    root = os.path.abspath(os.fspath(root))
    candidate = os.path.abspath(os.fspath(path))
    real_root, real_file = os.path.realpath(root), os.path.realpath(candidate)
    if (os.path.normcase(root) != os.path.normcase(real_root)
            or os.path.normcase(candidate) != os.path.normcase(real_file)
            or os.path.commonpath([real_root, real_file]) != real_root
            or real_file == real_root):
        raise ValueError('sticker path is outside the approved directory or uses a link')
    cursor = candidate
    while True:
        info = os.lstat(cursor)
        if (stat.S_ISLNK(info.st_mode)
                or getattr(info, 'st_file_attributes', 0) & 0x400):
            raise ValueError('sticker links/reparse points are not allowed')
        parent = os.path.dirname(cursor)
        if parent == cursor:
            break
        cursor = parent
    info = os.stat(candidate)
    extension = os.path.splitext(candidate)[1].lower()
    if not stat.S_ISREG(info.st_mode) or not 0 < info.st_size <= MAX_BYTES or extension not in IMAGE_TYPES:
        raise ValueError('sticker must be an approved image of at most 4 MiB')
    (image_check or _verify_image)(candidate, IMAGE_TYPES[extension])
    with open(candidate, 'rb') as stream:
        digest = hashlib.sha256(stream.read(MAX_BYTES + 1)).hexdigest()
    after = os.stat(candidate)
    if (info.st_size, info.st_mtime_ns, info.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
        raise ValueError('sticker changed while validating')
    return candidate, (after.st_size, after.st_mtime_ns, after.st_ino, digest)


def _contacts(db, key):
    rows = db.search_contact(key)
    # Runtime search_contact has LIMIT 50. A truncated result cannot prove uniqueness.
    if not isinstance(rows, list) or len(rows) >= 50:
        raise ValueError('contact search is unavailable or truncated')
    return [row for row in rows if isinstance(row, dict)]


def _input_title(raw):
    # The runtime appends this known accessibility hint, not a recipient name.
    # No substring/partial matching or unread-count stripping is permitted.
    return re.sub(r'(?:(?:长按|按住)鼠标\s*)?语音输入(?:文字)?$', '', str(raw or '').strip()).strip()


def resolve_target(db, shown, username=''):
    """Resolve an exact canonical username and unambiguous exact title aliases.

    No first search hit, substring, group-member alias or cached open-chat name.
    Every admitted alias is checked for collisions across exact contact hits.
    """
    key = str(username or shown or '').strip()
    if not key:
        raise ValueError('target is empty')
    hits = _contacts(db, key)
    exact = [row for row in hits if key in {str(row.get(k) or '').strip()
                                           for k in ('username', 'nick_name', 'remark')}]
    ids = {str(row.get('username') or '').strip() for row in exact}
    ids.discard('')
    filehelper = key in {'filehelper', '文件传输助手'}
    if filehelper:
        if ids - {'filehelper'}:
            raise ValueError('target name is ambiguous')
        canonical = 'filehelper'
        aliases = {'filehelper', '文件传输助手'}
    else:
        if len(ids) != 1:
            raise ValueError('target cannot be resolved uniquely')
        canonical = next(iter(ids))
        if username and canonical != str(username).strip():
            raise ValueError('canonical target does not match requested username')
        row = next(row for row in exact if row.get('username') == canonical)
        aliases = {canonical, str(row.get('nick_name') or '').strip(), str(row.get('remark') or '').strip()}
        aliases.discard('')
    safe = set()
    for alias in aliases:
        others = _contacts(db, alias)
        matched = {str(row.get('username') or '').strip() for row in others
                   if alias in {candidate for k in ('username', 'nick_name', 'remark')
                                for candidate in (str(row.get(k) or '').strip(), _input_title(row.get(k)))}}
        if matched - {canonical}:
            continue
        safe.add(alias)
    if not safe:
        raise ValueError('all target aliases are ambiguous')
    return canonical, frozenset(safe)


def account_evidence_allowed(*, configured_account, db_account, reason, explicit_pin, account_dirs):
    """May a sole visible WeChat window be trusted for this account?

    Text messages have always accepted "only one window is visible". Stickers
    used to demand more (an explicit window pin), which made them fail on every
    machine that has more than one historical account directory while only one
    account is logged in now. Accept the same evidence as text sends, but only
    when the operator explicitly configured the account and the database was
    opened with exactly that account; otherwise the choice is ambiguous.
    """
    if explicit_pin:
        return True
    if str(reason or '') != '本机只登了一个号' or len(account_dirs or []) <= 1:
        return True
    wanted, current = str(configured_account or '').strip(), str(db_account or '').strip()
    return bool(wanted and current and wanted == current)


def db_identity(db):
    identity = (str(getattr(db, 'account', '') or ''), str(getattr(db, 'wxid', '') or ''))
    if not all(identity):
        raise ValueError('database account identity is unavailable')
    return identity


def watermark(db, username):
    rows = db.get_messages(username, limit=20)
    if not isinstance(rows, list):
        raise ValueError('database baseline is unavailable')
    return max((int(row.get('sort_seq') or 0) for row in rows), default=0)


def _outgoing(db, message, own_username):
    sender = str(message.get('sender_username') or '')
    if not sender and message.get('shard') and message.get('sender_id') is not None:
        resolver = getattr(db, 'sender_username', None)
        if callable(resolver):
            sender = str(resolver(message['shard'], message['sender_id']) or '')
    # real_sender_id is SHARD-LOCAL. In particular, sender_id == 2 is not proof.
    return sender == own_username


def confirm_delivery(db, username, baseline, identity, gate, timeout=5.0,
                     clock=time.monotonic, sleep=time.sleep):
    deadline = clock() + timeout
    while True:
        if not gate():
            return result('unconfirmed', 'send was attempted; switch/generation changed before confirmation; do not retry')
        try:
            if db_identity(db) != identity:
                return result('unconfirmed', 'database account changed; do not retry')
            messages = db.get_new_messages(username, since_seq=baseline, limit=30)
            candidates = [m for m in messages if int(m.get('sort_seq') or 0) > baseline
                          and m.get('type') in MEDIA_TYPES and _outgoing(db, m, identity[1])]
            # More than one candidate is ambiguous. Never claim which image was sent.
            if len(candidates) == 1:
                return result('confirmed')
            if len(candidates) > 1:
                return result('unconfirmed', 'multiple outgoing media messages; delivery is ambiguous; do not retry')
        except Exception:
            return result('unconfirmed', 'database confirmation unavailable; do not retry')
        if clock() >= deadline:
            return result('unconfirmed', 'no new outgoing media message confirmed; do not retry')
        sleep(0.25)


class WindowsDesktop:
    """Lazy adapter; constructed only after all master/account gates passed."""
    def __init__(self):
        import win32gui
        import uiautomation
        self.windows = win32gui
        self.automation = uiautomation

    def foreground(self, hwnd):
        return bool(self.windows.IsWindow(hwnd)
                    and self.windows.GetForegroundWindow() == hwnd
                    and self.windows.GetAncestor(hwnd, 2) == hwnd)

    def focused(self, control, hwnd):
        focused = self.automation.GetFocusedControl()
        return bool(control.HasKeyboardFocus and focused is not None
                    and control.GetRuntimeId() and control.GetRuntimeId() == focused.GetRuntimeId()
                    and focused.GetTopLevelControl().NativeWindowHandle == hwnd)

    def value(self, control):
        pattern = control.GetValuePattern()
        if pattern is None:
            raise ValueError('input value pattern is unavailable')
        return pattern.Value

    def clipboard_matches(self, path):
        import win32clipboard
        win32clipboard.OpenClipboard()
        try:
            files = win32clipboard.GetClipboardData(15)  # CF_HDROP, not text/bitmap
            return (len(files) == 1
                    and os.path.normcase(os.path.abspath(files[0])) == os.path.normcase(path))
        finally:
            win32clipboard.CloseClipboard()


def quarantined_input_value(gui, hwnd, aliases):
    """Read-only proof for a quarantined target; never creates/rebinds UIA.

    None means unavailable or a different target. Empty string is useful only
    after nonempty draft/value evidence was observable for this quarantine.
    """
    try:
        if gui is None or int(gui.main_hwnd) != hwnd:
            return None
        uia = getattr(gui, '_uia', None)
        if (uia is None or int(getattr(uia, '_pinned_hwnd', 0)) != hwnd
                or uia._win is None or int(uia._win.NativeWindowHandle) != hwnd
                or uia.current_chat() not in aliases):
            return None
        control = uia._chat_input()
        if (control is None or getattr(control, 'ControlTypeName', '') != 'EditControl'
                or _input_title(getattr(control, 'Name', '')) not in aliases
                or 'chat_input_field' not in str(getattr(control, 'AutomationId', '')).split('.')):
            return None
        pattern = control.GetValuePattern()
        value = pattern.Value if pattern is not None else None
        return value if isinstance(value, str) else None
    except Exception:
        return None


def guarded_send(gui, uia, hwnd, aliases, path, root, db, username, gate,
                 account_valid, activity_allowed, desktop=None, image_check=None,
                 sleep=time.sleep, confirm_timeout=5.0):
    """One paste and at most one Enter; the caller owns send_lock + gui_lock.

    gate must reread disk and backend generation. Returns structured evidence,
    never a truthy response object pretending that a failed operation succeeded.
    Cancellation after paste is *unconfirmed*, as a draft may remain. No global
    cleanup keys are sent into a possibly changed window; clear such drafts by
    hand before any future send.
    """
    touched = False
    attempted_enter = False
    draft_observed = False
    try:
        if not gate():
            return result('cancelled', 'stickers are disabled or generation expired')
        if not aliases or not hwnd or not account_valid() or not activity_allowed():
            return result('failed', 'account or activity gate rejected the sticker')
        desktop = desktop or WindowsDesktop()
        identity = db_identity(db)
        baseline = watermark(db, username)
        approved, fingerprint = validate_path(path, root, image_check)

        def guard():
            # Potentially blocking HTTP/DB work precedes immediate window/title/focus reads.
            if not gate() or not activity_allowed() or not account_valid() or db_identity(db) != identity:
                return None
            if (not desktop.foreground(hwnd) or int(getattr(gui, 'main_hwnd', 0)) != hwnd
                    or int(getattr(uia, '_pinned_hwnd', 0)) != hwnd
                    or uia._win is None or int(uia._win.NativeWindowHandle) != hwnd
                    or uia.current_chat() not in aliases):
                return None
            control = uia._chat_input()
            if (control is None or getattr(control, 'ControlTypeName', '') != 'EditControl'
                    or _input_title(getattr(control, 'Name', '')) not in aliases):
                return None
            aid = str(getattr(control, 'AutomationId', '') or '')
            if 'chat_input_field' not in aid.split('.') or not desktop.focused(control, hwnd):
                return None
            return control

        control = guard()
        if control is None:
            return result('failed', 'open the exact target in the pinned foreground window and focus its input')
        if desktop.value(control) != '':
            return result('failed', 'input contains a draft; clear it manually before sending')
        # Validation can take time. Repeat guards before changing the clipboard/pasting.
        if validate_path(approved, root, image_check)[1] != fingerprint:
            return result('failed', 'sticker file changed before paste')
        if guard() is None:
            return result('cancelled', 'send gates changed before paste')
        if not gui.copy_files_to_clipboard([approved]):
            return result('failed', 'unable to prepare attachment clipboard')
        control = guard()
        if control is None or desktop.value(control) != '' or not desktop.clipboard_matches(approved):
            return result('cancelled', 'target/focus/switch/draft/clipboard changed before paste')
        # Mark uncertain BEFORE calling a side-effectful function (it can partially act then raise).
        touched = True
        gui._input.key(0x56, ctrl=True)  # one Ctrl+V; no select-all/delete or paste retry
        sleep(0.4)
        control = guard()
        value = desktop.value(control) if control is not None else None
        draft_observed = isinstance(value, str) and value != ''
        if value != '\ufffc':
            return result('unconfirmed', 'no exact attachment draft evidence; Enter not pressed; clear draft manually; do not retry',
                          draft_may_remain=True, draft_observed=draft_observed)
        # Recheck immediately at the irreversible action boundary, including backend generation.
        control = guard()
        if control is None or desktop.value(control) != '\ufffc':
            return result('unconfirmed', 'send gates changed after paste; Enter not pressed; clear draft manually; do not retry',
                          draft_may_remain=True, draft_observed=draft_observed)
        attempted_enter = True
        gui._input.key(0x0D)  # exactly one Enter, never Ctrl+Enter or retry
        outcome = confirm_delivery(db, username, baseline, identity, gate,
                                   timeout=confirm_timeout, sleep=sleep)
        if outcome['status'] != 'confirmed':
            outcome.update(draft_may_remain=True, draft_observed=draft_observed)
        return outcome
    except Exception:
        if touched or attempted_enter:
            return result('unconfirmed', 'attachment action is uncertain; a draft may remain; do not retry',
                          draft_may_remain=True, draft_observed=draft_observed)
        return result('failed', 'sticker safety checks or transport are unavailable')
