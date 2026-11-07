# -*- coding: utf-8 -*-
"""Bridge runtime mixin: VoiceMixin."""
import engine as G


class VoiceMixin:

    def send_voice_reply(self, text, who, username, cancelled=None, outcome=None):
        if not self.group_is_alive(username) or not self.account_send_allowed('自动语音'):
            return False
        if cancelled is not None and cancelled():
            if outcome is not None:
                outcome.update(Status='failed', Error='语音测试已取消')
            return False
        hwnd = int(self.ACCOUNT.get('hwnd') or 0)
        if not hwnd:
            return False

        def prepare():
            if (not self.group_is_alive(username) or not self.sticker_quarantine_allows(username, who) or (not self.account_send_allowed('自动语音发送前'))) or int(self.ACCOUNT.get('hwnd') or 0) != hwnd:
                return ''
            with self.gui_lock:
                if self.gui is None:
                    self.gui = self.WeChatGUI()
                self.bind_gui_window(self.gui)
                u = self.gui._get_uia()
                if u is None:
                    return ''
                keys = self.aliases_for(username, who)
                if u.current_chat() not in keys and (not u.open_chat(keys)):
                    return ''
                current = str(u.current_chat() or '')
                if current not in keys:
                    return ''
                return current
        return G.voice_reply.deliver(G.ROOT, text, hwnd, prepare, G.log, cancelled=cancelled, outcome=outcome, send_lock=self.send_lock)

    def voice_test_loop(self):
        while True:
            try:
                G.voice_send_test.process_pending(G.ROOT, self.send_voice_reply)
            except Exception:
                pass
            G.time.sleep(0.25)
