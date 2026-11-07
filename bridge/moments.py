"""按需读取当前桥接账号的朋友圈缓存；没有 UI 操作，也不下载媒体。"""
import threading


def collect(db, query, factory=None):
    if factory is None:
        from wechatauto import MomentDB
        factory = MomentDB
    limit = query.get('limit', 20)
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 50:
        raise ValueError('invalid limit')
    username = str(getattr(db, 'wxid', '') or '') if query.get('own') else str(query.get('username') or '')
    if query.get('own') and not username:
        raise ValueError('missing account')
    rows = factory(db).get_moments(limit=limit, keyword=str(query.get('keyword') or '')[:100] or None,
                                  username=username[:120] or None)
    # 仅返回展示所需字段：不把媒体 URL、路径、定位或评论者信息一并送到内核。
    return [{
        'id': str(row.get('id') or row.get('tid') or '')[:120],
        'username': str(row.get('username') or '')[:120],
        'nickname': str(row.get('nickname') or '')[:120],
        'text': str(row.get('text') or '')[:6000],
        'create_time': row.get('create_time') or 0,
        'imageCount': len(row.get('images') or []),
        'videoCount': len(row.get('videos') or []),
    } for row in rows[:limit]]


class MomentsReader:
    def __init__(self, db, http, base, headers, log, factory=None, interact=None):
        self.db, self.http, self.base = db, http, base
        self.headers, self.log, self.factory = headers, log, factory
        self.interact = interact
        self.stop_event = threading.Event()

    def tick(self):
        response = self.http.post(self.base + '/api/moments/claim',
                                  json={'account': self.db.wxid}, headers=self.headers, timeout=8)
        if response.status_code != 200:
            return
        job = response.json().get('job')
        if not job:
            return
        result = {'id': job['id'], 'account': self.db.wxid}
        try:
            if job.get('action', 'read') == 'read':
                result['items'] = collect(self.db, job['query'], self.factory)
            elif self.interact:
                result['performed'] = bool(self.interact(job['action'], job['query']))
            else:
                result['error'] = 'unsupported'
        except ImportError:
            result['error'] = 'unsupported'
        except Exception as exc:
            result['error'] = 'read_failed'
            # 异常正文可能含 XML/本机路径：日志只留异常类型，不输出朋友圈内容。
            self.log('朋友圈读取失败 type=%s' % type(exc).__name__)
        self.http.post(self.base + '/api/moments/complete', json=result,
                       headers=self.headers, timeout=8)

    def run(self):
        failed = False
        while not self.stop_event.is_set():
            try:
                self.tick()
                failed = False
            except Exception as exc:
                # 内核未启动时不能每五秒刷屏；恢复后才允许记录下一轮失败。
                if not failed:
                    self.log('朋友圈通道异常 type=%s' % type(exc).__name__)
                failed = True
            self.stop_event.wait(5)

    def start(self):
        thread = threading.Thread(target=self.run, name='moments-read', daemon=True)
        thread.start()
        return self

    def stop(self):
        self.stop_event.set()
