# -*- coding: utf-8 -*-
"""Bridge runtime mixin: ReceiverMixin."""
import engine as G


class ReceiverMixin:

    def _get_media(self):
        """按需创建媒体下载器；图片和表情识别共用一个实例。

        多条消息现在会并发识别图片，所以创建过程要加锁：否则会同时 new 出
        两个 MediaDownloader，各自往同一个缓存目录里落文件。
        """
        with self._media_lock:
            if self._media_box['downloader'] is not None:
                return self._media_box['downloader']
            save_dir = G.os.path.join(G.ROOT, 'data', 'media-cache')
            G.os.makedirs(save_dir, exist_ok=True)
            dl = self.MediaDownloader(self.db, save_dir=save_dir)
            from image_cache import bind_target_probe
            bind_target_probe(dl)
            try:
                from media_fallback import install_media_fallback
                installed = install_media_fallback(dl, self.db, log=G.log, root_names=G.DB_ROOT_NAMES)
                if installed:
                    G.log('图片目录兜底已就位（%d 处补丁）' % installed)
            except Exception as _e:
                G.log('图片目录兜底没装上（默认路径不受影响）：', repr(_e))
            self._media_box['downloader'] = dl
            return dl

    def describe_image(self, msg):
        try:
            import base64
            user = msg.get('username') or ''
            lid = msg.get('local_id')
            shard = msg.get('shard')
            if not user or lid is None:
                return ''
            path = None
            for _attempt in range(4):
                for _tier in ('full', 'best'):
                    try:
                        path = self._get_media().download_image(user, int(lid), tier=_tier, shard=shard)
                    except Exception as _e:
                        G.log('图片下载失败（tier=%s）：%r' % (_tier, _e))
                        path = None
                    if path:
                        G.log('图片档位：%s → %d KB' % (_tier, G.os.path.getsize(path) // 1024))
                        break
                if path:
                    break
                if _attempt < 3:
                    G.log('图片缓存尚未就绪，等待重试（%d/3）' % (_attempt + 1))
                    G.time.sleep((0.5, 1.0, 2.0)[_attempt])
            if not path:
                G.log('图片读取失败：已重试；请确认接收端微信已下载图片（消息id=%s，分片=%s）' % (lid, shard))
                return ''
            with open(path, 'rb') as f:
                raw = f.read()
            if len(raw) > 8 * 1024 * 1024:
                G.log('图片太大，跳过')
                return ''
            if raw[:4] == b'wxgf':
                try:
                    conv = self._get_media()._wxgf_to_jpg(raw)
                except Exception as _e:
                    conv = None
                    G.log('wxgf 转码异常：', repr(_e))
                if not conv:
                    G.log('这张图是 wxgf/HEVC，本机 ffmpeg 没能转出来，跳过（装 ffmpeg 到 C:\\ffmpeg 即可）')
                    return ''
                raw = conv
                ext = '.jpg'
            elif raw[:8] == b'\x89PNG\r\n\x1a\n':
                ext = '.png'
            elif raw[:3] == b'\xff\xd8\xff':
                ext = '.jpg'
            elif raw[:3] == b'GIF':
                ext = '.gif'
            else:
                ext = G.os.path.splitext(path)[1].lower()
                if ext not in ('.jpg', '.jpeg', '.png', '.gif'):
                    G.log('图片格式不认识（%s），跳过' % raw[:4])
                    return ''
            mime = 'image/png' if ext == '.png' else 'image/gif' if ext == '.gif' else 'image/jpeg'
            base = self.bot_url.rsplit('/webhook', 1)[0]
            parts = [raw]
            try:
                from PIL import Image
                import io as _io
                img = Image.open(_io.BytesIO(raw))
                img.load()
                w, h = img.size
                if w > 0 and h / float(w) > 2.2 and (h > 1200):
                    n = 3 if h / float(w) > 4.0 else 2
                    overlap = int(h * 0.08)
                    parts = []
                    for i in range(n):
                        top = max(0, int(i * h / n) - (overlap if i else 0))
                        bottom = min(h, int((i + 1) * h / n) + overlap)
                        seg = img.crop((0, top, w, bottom)).convert('RGB')
                        buf = _io.BytesIO()
                        seg.save(buf, format='JPEG', quality=88)
                        parts.append(buf.getvalue())
                    mime = 'image/jpeg'
                    G.log('长截图 %dx%d，切成 %d 段分别识别' % (w, h, len(parts)))
                    mime = 'image/jpeg'
                else:
                    img2 = img.convert('RGB')
                    buf = _io.BytesIO()
                    img2.save(buf, format='JPEG', quality=88)
                    parts = [buf.getvalue()]
                    mime = 'image/jpeg'
            except Exception as _e:
                G.log('图片预处理跳过（用原图）：', repr(_e))
                parts = [raw]
            texts = []
            for idx, part in enumerate(parts):
                prompt = ''
                if len(parts) > 1:
                    prompt = '这是一张长截图从上往下的第 %d/%d 段。逐条转写这一段里的文字（分清左边对方/右边本人），不要省略。' % (idx + 1, len(parts))
                r = G.LOCAL_HTTP.post(base + '/api/vision', json={'image': base64.b64encode(part).decode(), 'mime': mime, 'prompt': prompt}, timeout=120)
                data = r.json()
                piece = str(data.get('text') or '').strip()
                if piece:
                    texts.append(piece)
                if not data.get('ok', True):
                    G.log_throttled('img-fail:' + str(data.get('error'))[:40], '第 %d 段识别失败：%s' % (idx + 1, data.get('error')))
            text = '\n'.join(texts).strip()
            if len(text) > 1200:
                text = text[:1200] + '…'
            G.log('图片识别：', text[:80])
            return text
        except Exception as e:
            if isinstance(msg, dict):
                msg['_media_fail'] = type(e).__name__
            G.log_throttled('img-exc:' + type(e).__name__, '图片识别失败：', repr(e))
            return ''

    def describe_emoji(self, msg):
        """表情包 → 文字描述；失败返回空串（调用方跳过，不回话）。"""
        try:
            import base64
            from emoji_vision import load_preview

            preview = None
            for attempt in range(4):
                preview = load_preview(self.db.account_dir, msg.get('content'), allow_network=attempt == 3)
                if preview:
                    break
                if attempt < 3:
                    G.time.sleep((0.5, 1.0, 2.0)[attempt])
            if not preview:
                G.log('表情包读取失败：本地缓存不可解码，且消息没有可取得的原图')
                return ''
            raw, frames = preview
            prompt = '这是对方发来的表情包。简短描述主体、表情、动作和画面文字，看不清就说明，不要编造。'
            if frames > 1:
                prompt += '从左到右是同一动画的%d个抽样帧，结合它们理解，不要当成不同图片；未展示的动作不要猜。' % frames
            response = G.LOCAL_HTTP.post(self.bot_url.rsplit('/webhook', 1)[0] + '/api/vision', json={'image': base64.b64encode(raw).decode(), 'mime': 'image/png', 'prompt': prompt}, timeout=120)
            data = response.json()
            if not data.get('ok'):
                G.log('表情包识图接口失败：', str(data.get('error') or '未知错误')[:160])
                return ''
            text = str(data.get('text') or '').strip()[:1200]
            G.log('表情包识别（%d帧）：' % frames, text[:80])
            return text
        except Exception as exc:
            if isinstance(msg, dict):
                msg['_media_fail'] = type(exc).__name__
            G.log('表情包识别异常：', type(exc).__name__)
            return ''

    def transcribe_voice(self, msg):
        """语音消息 → 文字；失败返回空串。"""
        if not G.VOICE_ENABLED:
            G.log('语音识别已关闭（voice.enabled=false）')
            return ''
        if not G.VOICE_API_KEY:
            G.log_throttled('voice-key-missing', '语音识别未配置对应服务商的 Key，请在启动器「看图与语音」中填写语音 Key')
            return ''
        try:
            import io
            import wave
            user = msg.get('username') or ''
            lid = msg.get('local_id')
            shard = msg.get('shard')
            if not user or lid is None:
                return ''
            path = self._get_media().download_voice(user, int(lid), shard=shard)
            if not path:
                G.log('语音没落盘（这条微信没缓存到本地），跳过')
                return ''
            try:
                import pysilk
            except Exception:
                G.log('缺少 pysilk，装一下：pip install silk-python')
                return ''
            pcm = io.BytesIO()
            with open(path, 'rb') as f:
                pysilk.decode(f, pcm, G.VOICE_SAMPLE_RATE)
            raw = pcm.getvalue()
            seconds = len(raw) / float(G.VOICE_SAMPLE_RATE * 2)
            if seconds < 0.3:
                G.log('语音太短（%.1fs），跳过' % seconds)
                return ''
            if seconds > G.VOICE_MAX_SECONDS:
                G.log('语音太长（%.0fs > %.0fs），跳过' % (seconds, G.VOICE_MAX_SECONDS))
                return ''
            wav_path = G.os.path.splitext(path)[0] + '.wav'
            try:
                with wave.open(wav_path, 'wb') as w:
                    w.setnchannels(1)
                    w.setsampwidth(2)
                    w.setframerate(G.VOICE_SAMPLE_RATE)
                    w.writeframes(raw)
                with open(wav_path, 'rb') as f:
                    text = G.asr_transcribe(f.read(), G.VOICE_API_KEY, G.VOICE_MODEL, G.VOICE_BASE_URL, G.VOICE_TIMEOUT)
            finally:
                try:
                    G.os.remove(wav_path)
                except Exception:
                    pass
            text = G.clean_transcript(text)
            G.log('语音识别（%.1fs）：%s' % (seconds, text[:60] or '（空）'))
            return text
        except Exception as e:
            if isinstance(msg, dict):
                msg['_media_fail'] = type(e).__name__
            G.log_throttled('voice-fail:' + type(e).__name__, '语音识别失败：', repr(e))
            return ''

    def on_message_inner(self, msg, listener):

        def media_failed(kind):
            """识别失败照旧不回话，但补一条能把「哪条、谁的、为什么没回」对上的 error 日志。

            以前失败只在识别函数里留零散日志（连消息 id 都没有），事后完全没法回答
            「这条消息她为什么没回」。节流 key 带消息 id：同一条反复失败只记一次，
            别的消息照常各记一条，不会被节流误吞。
            """
            msg_id = '%s:%s:%s' % (username, msg.get('shard') or '', msg.get('local_id'))
            try:
                chat = self.display_name(username)
            except Exception:
                chat = username
            sender = msg.get('sender_username') or ''
            try:
                who = self.db.get_nickname(sender) or ''
            except Exception:
                who = ''
            if not who:
                who = '群友' if username.endswith('@chatroom') else '微信好友'
            reason = msg.pop('_media_fail', None) or '空描述（识别结果为空）'
            G.log_throttled('media-fail:%s:%s' % (msg_id, kind), '识别失败（这条不回话）：会话=%s 发送者=%s 类型=%s 消息id=%s 原因=%s' % (chat, who, kind, msg_id, reason), emit=G.log_error)
        try:
            username = msg.get('username') or ''
            if not username:
                return
            sender = msg.get('sender_username') or ''
            if sender == self.me:
                return
            mtype = msg.get('type') or ''
            content = G.fix_garbled((msg.get('content') or '').strip())
            is_emoji = mtype in ('表情', '动画表情') or (mtype == '图片' and '<emoji' in content)
            if is_emoji:
                desc = self.describe_emoji(msg)
                if not desc:
                    media_failed('表情')
                    return
                content = '（对方发了一个表情包，画面是：%s）' % desc
            elif mtype == '图片':
                desc = self.describe_image(msg)
                if not desc:
                    media_failed('图片')
                    return
                content = '（对方发了一张图片，图里是：%s）' % desc
            if mtype == '语音':
                said = self.transcribe_voice(msg)
                if not said:
                    G.log('语音没识别出内容，先不说话')
                    media_failed('语音')
                    return
                content = '（对方发了一条语音，说的是：%s）' % said
            if mtype not in ('文本', '语音', '图片', '表情', '动画表情'):
                if '移出群聊' in content or '移出' in content:
                    self.dead_chats.add(username)
                    G.log('被移出群聊，停掉这个会话：', self.display_name(username))
                    return
                _low = content.lower()
                if 'finderfeed' in _low or '<type>51</type>' in _low or ('视频号' in content and '<url>' in _low):
                    G.log('收到视频号卡片，装死（不识别不回）')
                    return
                import re as _re
                mu = _re.search('<url>(.*?)</url>', content, _re.S)
                mt = _re.search('<title>(.*?)</title>', content, _re.S)
                if mu:
                    title = (mt.group(1).strip() if mt else '')[:60]
                    content = '分享了一个链接：%s %s' % (title, mu.group(1).strip())
                else:
                    return
            if G.ONLY_CHATS:
                try:
                    if self.display_name(username) not in G.ONLY_CHATS:
                        return
                except Exception:
                    return
            if mtype == '文本':
                content = G.fix_garbled((msg.get('content') or '').strip())
                if username.endswith('@chatroom'):
                    content = G._GROUP_SENDER_PREFIX_RE.sub('', content, count=1).strip()
            if not content or content.startswith('<'):
                return
            is_group = username.endswith('@chatroom')
            nickname = ''
            try:
                nickname = self.db.get_nickname(sender) or ''
            except Exception:
                nickname = ''
            if not nickname:
                nickname = '群友' if is_group else '微信好友'
            if G.is_system_notice(username, nickname, content):
                if G.ONLY_CHATS:
                    return
                G.log('跳过系统通知：', nickname, '：', content[:24])
                return
            if G.duplicate_guard(username, sender, content):
                G.log('跳过重复消息：', nickname, '：', content[:20])
                return
            if '拍了拍' in content and '<url>' not in content:
                G.log('跳过拍一拍提示：', content[:24])
                return
            import re as _mention_re
            _at_text = content.replace('\u2005', ' ')
            addressed = any((a and _mention_re.search('@\\s*' + _mention_re.escape(str(a)) + '(?=$|[\\s，,：:！!~～…?？。\\-—])', _at_text) for a in self.aliases))
            _at_remainder = _mention_re.sub('^[A-Za-z0-9_\\-]{4,}:\\s*', '', _at_text).strip()
            for _alias in self.aliases:
                if _alias:
                    _at_remainder = _mention_re.sub('@\\s*' + _mention_re.escape(str(_alias)), ' ', _at_remainder)
            _bare_mention = not _at_remainder.strip(' \t\r\n，,。.!！?？…~～')
            if username.endswith('@chatroom') and addressed and _bare_mention:
                try:
                    for m in self.db.get_messages(username, limit=12):
                        if m.get('type') != '文本':
                            continue
                        if (m.get('sender_username') or '') != sender:
                            continue
                        prev = G.fix_garbled((m.get('content') or '').strip())
                        prev = __import__('re').sub('^[A-Za-z0-9_\\-]{4,}:\\s*', '', prev).strip()
                        if prev and (not any((a in prev for a in self.aliases))):
                            content = prev
                            G.log('补上一条问题：', prev[:20])
                            break
                except Exception as e:
                    G.log('补问题失败：', repr(e))
            _mentioned_names = []
            if is_group:
                for _hit in _mention_re.findall('@\\s*([^\\s@，,：:！!~～…?？。—]+)', _at_text):
                    _name = str(_hit).strip()
                    if _name and _name not in self.aliases and (_name not in _mentioned_names):
                        _mentioned_names.append(_name)
            G.log('收到', '群' if is_group else '私聊', self.display_name(username), '←', nickname, '：', content[:30])
            payload = {'chat_id': username, 'chat_type': 'group' if is_group else 'private', 'user_id': sender or 'unknown', 'senderId': sender or 'unknown', 'sender_id': sender or 'unknown', 'senderName': nickname, 'nickname': nickname, 'text': content, 'msg_id': '%s:%s:%s' % (username, msg.get('shard') or '', msg.get('local_id')), 'at_me': addressed, 'mentioned_names': _mentioned_names, 'chat_title': self.display_name(username) if is_group else ''}
            try:
                headers = {'x-whale-bridge': '1'}
                if self.token:
                    headers['x-bot-token'] = self.token
                r = G.LOCAL_HTTP.post(self.bot_url, json=payload, headers=headers, timeout=120)
                if r.status_code != 200:
                    G.CONN_STATE['ok'] = False
                    hint = '桥接 token 不匹配，请核对配置并重启桥接' if r.status_code in (401, 403) else '请查看内核诊断日志'
                    G.log_throttled('webhook-http:' + str(r.status_code), '鲸鲸接口返回 HTTP %s：%s' % (r.status_code, hint))
                    return
                data = r.json()
                if not isinstance(data, dict) or data.get('ok') is not True:
                    G.CONN_STATE['ok'] = False
                    G.log_throttled('webhook-response', '鲸鲸接口返回异常，未发送回复')
                    return
                if data.get('skipped') == 'adapter_disabled':
                    G.log_throttled('adapter-disabled', '微信网关未开启，请在启动器设置中开启 gateway.wechat.enabled')
                    return
            except Exception as e:
                _msg = repr(e)
                if '10061' in _msg or 'refused' in _msg.lower() or '积极拒绝' in _msg:
                    G.log_throttled('conn-refused', '连不上本地服务（积极拒绝 = 127.0.0.1 上没有程序在监听）。先在启动器里点「启动」，等状态变成「运行中」再来。')
                    if G.CONN_STATE.get('ok') is not False:
                        G.CONN_STATE['ok'] = False
                else:
                    G.log_throttled('webhook-fail:' + _msg[:40], '请求鲸鲸失败：', _msg)
                return
            if G.CONN_STATE.get('ok') is not True:
                G.CONN_STATE['ok'] = True
                G.log('已连上鲸鲸服务：', self.bot_url.rsplit('/webhook', 1)[0])
            if data.get('action') != 'reply' or not data.get('reply'):
                if is_group and addressed:
                    G.log('鲸鲸没接话：', nickname, '| 原因:', data.get('reason'), '| %d 字' % len(content))
                return
            if data.get('mock') and (not G.MOCK_NOTICED['done']):
                G.MOCK_NOTICED['done'] = True
                G.log('[!] 服务端现在是「演示模式」：没配置 API Key，她回的是内置台词，不是真模型。')
                G.log('    去网页右上角「设置」填一把 Key（DeepSeek / 智谱 都行）就会切成真模型。')
            target = self.display_name(username)
            bubbles = data.get('bubbles')
            if not isinstance(bubbles, list):
                bubbles = [data['reply']]
            bubbles = [line for line in bubbles if isinstance(line, str) and line.strip()]
            if not bubbles:
                bubbles = [str(data['reply'])]
            mention = str(data.get('mention') or '').strip()
            if not G.rate_guard(username):
                G.log('这一分钟回太多了，先停一下：', target)
                return
            if data.get('stickerOnly') is True:
                sticker = data.get('sticker')
                if G.STICKER_TEST_ON and isinstance(sticker, dict):
                    self.claim_and_send_sticker(sticker, expected_chat=target, expected_username=username)
                return
            G.log('[delivery] stage=reply chatType=%s bubbles=%d chars=%d' % ('group' if is_group else 'private', len(bubbles), sum((len(x or '') for x in bubbles))))
            first = True
            if data.get('error') or data.get('commandType'):
                G.log('[voice] stage=decision result=skip reason=error_or_command_reply')
            if not data.get('error') and (not data.get('commandType')) and G.voice_reply.choose(G.voice_reply.settings(G.ROOT), content, is_group, G.random.random, log=G.log):
                spoken = '\n'.join((line.strip() for line in bubbles if line.strip()))
                if self.send_voice_reply(spoken, target, username):
                    G.log('[delivery] stage=voice result=handled textFallback=false stickerFallback=false reason=voice_may_have_sent')
                    return
                G.log('[voice] stage=delivery result=text_fallback reason=prepare_or_synthesis_failed')
            for line in bubbles:
                if not line:
                    continue
                if first and mention and is_group:
                    body = line
                    for prefix in ('@%s' % mention, '@ %s' % mention):
                        if body.startswith(prefix):
                            body = body[len(prefix):].lstrip(' ，,：:')
                            break
                    if self.send_at(mention, body, target, username):
                        first = False
                        G.time.sleep(0.6)
                        continue
                    G.log('真 @ 失败，退回普通文本：', mention)
                    if not line.startswith('@'):
                        line = '@%s %s' % (mention, line)
                if not self.send_text(line, target, username, quote_text=content if first and G.QUOTE_REPLY else None):
                    G.log('[delivery] stage=text result=failed reason=send_failed remainingBubbles=cancelled stickers=cancelled')
                    return
                first = False
                G.time.sleep(0.6)
            _stk = data.get('sticker') or None
            if G.STICKER_TEST_ON and isinstance(_stk, dict):
                self.claim_and_send_sticker(_stk, expected_chat=target, expected_username=username)
            elif G.STICKER_TEST_ON:
                G.log('[sticker] stage=delivery result=skip reason=no_job_in_reply')
        except Exception as e:
            G.log('处理消息异常：', repr(e))

    def merge_text_batch(self, run, username):
        """同一个人连发的一串纯文本 → 合成一条消息交给服务端。

        只合并正文和消息 id；发送者、会话、shard 沿用最后一条。
        群消息正文前面带的 "wxid_xxx:" 前缀要先逐条剥掉，不然合并后
        模型会看到一串 wxid（原来每条各自剥，合并后只剥一次就漏了）。
        """
        merged = dict(run[-1])
        parts = []
        ids = []
        for m in run:
            text = G.fix_garbled((m.get('content') or '').strip())
            if username.endswith('@chatroom'):
                text = G._GROUP_SENDER_PREFIX_RE.sub('', text, count=1).strip()
            if text:
                parts.append(text)
            ids.append(str(m.get('local_id')))
        if not parts:
            return [run[-1]]
        merged['content'] = '\n'.join(parts)
        merged['local_id'] = '|'.join(ids)
        G.log('合并 %d 条连发消息一起回：%s' % (len(run), ' / '.join(parts)[:60]))
        return [merged]

    def flush_chat(self, chat, listener):
        """这个会话的上一轮跑完了：把攒下的消息取走，逐组处理。

        同一轮里同一个人连发的几条合成一条（只调一次模型、只发一次），
        不同人的消息分开回，顺序不乱。
        """
        try:
            items = self.batches.take(chat)
        except Exception as e:
            G.log('取消息批次失败：', repr(e))
            return
        if not items:
            return
        for run in G.split_runs(items):
            username = (run[0] or {}).get('username') or ''
            todo = self.merge_text_batch(run, username) if G.mergeable(run) else run
            for msg in todo:
                try:
                    self.on_message_inner(msg, listener)
                except Exception as e:
                    G.log('处理消息异常：', repr(e))

    def on_message(self, msg, listener):
        try:
            username = msg.get('username') or ''
            create_time = float(msg.get('create_time') or 0)
            if create_time and create_time < G.START_TS - G.SKIP_OLDER_THAN:
                return
            if create_time and G.time.time() - create_time > G.STALE_AFTER:
                G.log('跳过过期消息（%.0fs 前）：%s' % (G.time.time() - create_time, (msg.get('content') or '')[:20]))
                return
            chat = username or 'unknown'
            if self.batches.push(chat, msg):
                try:
                    queued = self.pipeline.submit(chat, self.flush_chat, chat, listener)
                except Exception:
                    queued = False
                if not queued:
                    self.batches.release(chat)
        except Exception as e:
            G.log('提交消息处理失败：', repr(e))

    def recent_chats(self, limit=2, within=1800):
        out = []
        try:
            for s in self.db.get_sessions(limit=20):
                u = s.get('username') or ''
                if not u or u == 'filehelper':
                    continue
                try:
                    ms = self.db.get_messages(u, limit=1)
                except Exception:
                    continue
                if not ms:
                    continue
                t = float(ms[0].get('create_time') or 0)
                if t and G.time.time() - t > within:
                    continue
                out.append((u, self.display_name(u)))
                if len(out) >= limit:
                    break
        except Exception:
            pass
        return out
