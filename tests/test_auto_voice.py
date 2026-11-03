import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import ast
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('voice_reply', ROOT / 'bridge' / 'voice_reply.py')
v = importlib.util.module_from_spec(spec)
spec.loader.exec_module(v)

class PolicyTests(unittest.TestCase):
    def test_off_does_not_create_job_or_start_worker(self):
        with tempfile.TemporaryDirectory() as root:
            with patch.object(v.subprocess, 'Popen') as start:
                self.assertFalse(v.deliver(root, '发语音', 1, lambda: '群', lambda *a: None))
                start.assert_not_called()
            self.assertFalse((Path(root) / 'data' / 'voice-send-jobs').exists())
    def test_explicit_requests(self):
        for text in ('发一条语音听听', '给我发条语音', '用语音回复我', '来一段语音', '鲸鲸，说句语音'):
            self.assertTrue(v.requested(text), text)
    def test_negatives_and_discussion(self):
        for text in ('不要发语音', '别发语音了', '怎么发语音', '他说发一条语音听听', '“发条语音”是什么意思', '今天吃什么'):
            self.assertFalse(v.requested(text), text)
    def test_probability_and_one_shot_override(self):
        c = {'Enabled': True, 'Probability': 25}
        self.assertTrue(v.choose(c, '你好', False, lambda: .249))
        self.assertFalse(v.choose(c, '你好', True, lambda: .25))
        c['Probability'] = 0
        self.assertTrue(v.choose(c, '发条语音听听', True, lambda: 1))
        self.assertFalse(v.choose(c, '接下来呢', True, lambda: 0))
    def test_off_and_chat_scope_override_explicit_request(self):
        for c in ({'Enabled': False}, {'Enabled': 'true'}, {'Enabled': True, 'Groups': False}):
            self.assertFalse(v.choose(c, '发条语音', True, lambda: 0))
        self.assertFalse(v.choose({'Enabled': True, 'Private': False}, '发条语音', False, lambda: 0))
    def test_invalid_probability_fails_closed(self):
        for chance in (None, 'bad', float('nan'), float('inf'), -1, 101):
            self.assertFalse(v.choose({'Enabled': True, 'Probability': chance}, '你好', False, lambda: 0))
    def test_text_request_overrides_even_hundred_percent_voice(self):
        for text in ('不要发语音', '别再发语音了', '用文字回复我', '文本回复'):
            self.assertFalse(v.choose({'Enabled': True, 'Probability': 100}, text, False, lambda: 0))
    def test_delivery_never_repeats_uncertain_voice(self):
        for status, handled in [('sent_unconfirmed', True), ('uncertain', True), ('failed', False)]:
            with self.subTest(status=status), tempfile.TemporaryDirectory() as root:
                data = Path(root) / 'data'; data.mkdir()
                (data / 'voice-send.json').write_text('{"Enabled":true}')
                class Process:
                    pid = 1
                    done = False
                    def __init__(self, args, **kwargs):
                        self.path = args[-1]
                        Path(self.path + '.ready').write_text('ready')
                    def poll(self): return 0 if self.done else None
                    def wait(self, **kwargs):
                        self.done = True
                        Path(self.path + '.result').write_text(json.dumps({'Status': status}))
                        return 0
                with patch.object(v.subprocess, 'Popen', Process):
                    self.assertEqual(v.deliver(root, '模型原始回复', 1, lambda: '测试群', lambda *a: None, allow_foreground=lambda pid: None), handled)
                self.assertEqual(list((data / 'voice-send-jobs').iterdir()), [])
    def test_prepare_failure_falls_back_before_recording(self):
        with tempfile.TemporaryDirectory() as root:
            data = Path(root) / 'data'; data.mkdir(); (data / 'voice-send.json').write_text('{"Enabled":true}')
            class Process:
                pid = 1
                def __init__(self, args, **kwargs): Path(args[-1] + '.ready').write_text('ready')
                def poll(self): return None
                def wait(self, **kwargs): return 0
            with patch.object(v.subprocess, 'Popen', Process):
                self.assertFalse(v.deliver(root, '同一回复', 1, lambda: '', lambda *a: None))

    def test_cancelled_test_never_starts_worker(self):
        with tempfile.TemporaryDirectory() as root:
            data = Path(root) / 'data'; data.mkdir(); (data / 'voice-send.json').write_text('{"Enabled":true}')
            outcome = {}
            with patch.object(v.subprocess, 'Popen') as start:
                self.assertFalse(v.deliver(root, '测试', 1, lambda: '文件传输助手', lambda *a: None,
                                           cancelled=lambda: True, outcome=outcome))
                start.assert_not_called()
            self.assertEqual(outcome['Status'], 'failed')

    def test_delivery_reports_worker_error_to_test_ui(self):
        with tempfile.TemporaryDirectory() as root:
            data = Path(root) / 'data'; data.mkdir(); (data / 'voice-send.json').write_text('{"Enabled":true}')
            class Process:
                pid = 1
                def __init__(self, args, **kwargs):
                    Path(args[-1] + '.result').write_text(json.dumps({'Status': 'failed', 'Error': 'HTTP 401'}))
                def poll(self): return 2
                def wait(self, **kwargs): return 2
            outcome = {}
            with patch.object(v.subprocess, 'Popen', Process):
                self.assertFalse(v.deliver(root, '测试', 1, lambda: '文件传输助手', lambda *a: None, outcome=outcome))
            self.assertEqual(outcome, {'Status': 'failed', 'Error': 'HTTP 401'})

class LatencyTests(unittest.TestCase):
    def test_timeout_validation(self):
        for value, expected in [(None,20), ('bad',20), (float('nan'),20), (0,5), (180,90), (12,12)]:
            self.assertEqual(v.synth_timeout({'SynthTimeoutSec':value}),expected)

    def test_engine_acquires_lock_only_after_synthesis(self):
        tree=ast.parse((ROOT/'bridge'/'engine.py').read_text(encoding='utf-8-sig'))
        fn=next(n for n in ast.walk(tree) if isinstance(n,ast.FunctionDef) and n.name=='send_voice_reply')
        self.assertFalse(any(isinstance(n,ast.With) for n in fn.body))
        call=fn.body[-1].value
        self.assertTrue(any(k.arg=='send_lock' for k in call.keywords))

    def test_other_chat_can_send_while_synthesizing_and_recording_is_exclusive(self):
        with tempfile.TemporaryDirectory() as root:
            data=Path(root)/'data';data.mkdir();(data/'voice-send.json').write_text('{"Enabled":true}')
            lock=threading.Lock();started=threading.Event();ready=threading.Event();errors=[]
            class Process:
                pid=1;done=False
                def __init__(self,args,**kwargs):self.path=args[-1];started.set()
                def poll(self):
                    if ready.is_set():Path(self.path+'.ready').touch()
                    return 0 if self.done else None
                def wait(self,**kwargs):
                    self.done=True
                    Path(self.path+'.result').write_text('{"Status":"sent_unconfirmed"}')
            def prepare():
                if lock.acquire(blocking=False):
                    lock.release();raise AssertionError('recording must own send lock')
                return '测试群'
            def run():
                try:self.assertTrue(v.deliver(root,'测试',1,prepare,lambda *a:None,send_lock=lock,allow_foreground=lambda pid:None))
                except BaseException as exc:errors.append(exc)
            with patch.object(v.subprocess,'Popen',Process):
                thread=threading.Thread(target=run);thread.start()
                try:
                    self.assertTrue(started.wait(2))
                    self.assertTrue(lock.acquire(timeout=1),'synthesis blocked unrelated text')
                    lock.release()
                finally:ready.set();thread.join(3)
            self.assertFalse(thread.is_alive());self.assertEqual(errors,[])
            self.assertTrue(lock.acquire(blocking=False));lock.release()

    def test_timeout_cancels_without_granting_recording_and_trips_cooldown(self):
        with tempfile.TemporaryDirectory() as root:
            data=Path(root)/'data';data.mkdir();(data/'voice-send.json').write_text('{"Enabled":true}')
            clock=[0.0];paths=[]
            class Process:
                pid=1;done=False
                def __init__(self,args,**kwargs):self.path=args[-1];paths.append(self.path)
                def poll(self):return 0 if self.done else None
                def wait(self,**kwargs):
                    self.done=True
                    self_cancel=Path(self.path+'.cancel').exists()
                    if not self_cancel:raise AssertionError('missing cancel')
                    if Path(self.path+'.go').exists():raise AssertionError('unexpected recording')
            def tick(_):clock[0]+=10
            with patch.object(v.subprocess,'Popen',Process),patch.object(v.time,'monotonic',lambda:clock[0]),patch.object(v.time,'sleep',tick):
                for _ in range(2):
                    outcome={}
                    self.assertFalse(v.deliver(root,'测试',1,lambda:self.fail('must not prepare'),lambda *a:None,outcome=outcome))
                    self.assertIn('20s',outcome['Error'])
                self.assertFalse(v.deliver(root,'测试',1,lambda:None,lambda *a:None))
                self.assertEqual(len(paths),2)
                clock[0]+=301
                self.assertFalse(v.deliver(root,'测试',1,lambda:None,lambda *a:None))
                self.assertEqual(len(paths),3)
            self.assertEqual(list((data/'voice-send-jobs').iterdir()),[])

    def test_local_preparation_failure_does_not_trip_provider_cooldown(self):
        with tempfile.TemporaryDirectory() as root:
            data=Path(root)/'data';data.mkdir();(data/'voice-send.json').write_text('{"Enabled":true}')
            class Process:
                pid=1;done=False
                def __init__(self,args,**kwargs):self.path=args[-1];Path(self.path+'.ready').touch()
                def poll(self):return 0 if self.done else None
                def wait(self,**kwargs):self.done=True
            with patch.object(v.subprocess,'Popen',Process):
                for _ in range(3):self.assertFalse(v.deliver(root,'测试',1,lambda:'',lambda *a:None))
            self.assertEqual(v._health[root],(0,0))

    def test_worker_network_failure_cools_down_but_local_error_does_not(self):
        for kind, expected in [('network',2),('http',2),('local',3)]:
            with self.subTest(kind=kind),tempfile.TemporaryDirectory() as root:
                data=Path(root)/'data';data.mkdir();(data/'voice-send.json').write_text('{"Enabled":true}')
                starts=[]
                class Process:
                    pid=1
                    def __init__(self,args,**kwargs):
                        starts.append(1)
                        Path(args[-1]+'.result').write_text(json.dumps({'Status':'failed','Error':'test','ErrorKind':kind,'RequestMs':123}))
                    def poll(self):return 2
                    def wait(self,**kwargs):return 2
                with patch.object(v.subprocess,'Popen',Process):
                    for _ in range(3):self.assertFalse(v.deliver(root,'测试',1,lambda:'群',lambda *a:None))
                self.assertEqual(len(starts),expected)

if __name__ == '__main__': unittest.main()
