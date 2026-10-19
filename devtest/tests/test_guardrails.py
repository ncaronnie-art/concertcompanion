"""Resumable transport, edit safety and complete-output tests. Generated media only."""
import copy, http.client, json, math, shutil, tempfile, threading, time, unittest, uuid
from pathlib import Path
from unittest.mock import patch
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import engine, server

class GuardrailTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=Path(tempfile.mkdtemp(prefix='compass-guardrails-'))
        cls.fixture=cls.temp/'synthetic.mp4'
        engine.ff(['-f','lavfi','-i','testsrc2=size=180x320:rate=30:duration=3',
                   '-f','lavfi','-i','sine=frequency=523:sample_rate=48000:duration=3',
                   '-c:v','libx264','-preset','ultrafast','-threads','2','-c:a','aac','-t','3',str(cls.fixture)])
        server.BASE=cls.temp/'sessions';server.BASE.mkdir()
        cls.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        threading.Thread(target=cls.http.serve_forever,daemon=True).start()
    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown();cls.http.server_close();shutil.rmtree(cls.temp,ignore_errors=True)
    def setUp(self):
        code,meta,data=self.call('GET','/api/state');self.assertEqual(code,200)
        d=json.loads(data);self.h={'Cookie':meta['Set-Cookie'].split(';')[0], 'X-Compass-CSRF':d['csrf'],'Content-Type':'application/json'}
    def tearDown(self):
        self.call('POST','/api/cancel','{}',self.h)
        for _ in range(150):
            with server.SESSIONS_LOCK:
                busy=any(s.busy for s in server.SESSIONS.values())
            if not busy:break
            time.sleep(.1)
        with server.SESSIONS_LOCK:
            for s in server.SESSIONS.values():shutil.rmtree(s.root,ignore_errors=True)
            server.SESSIONS.clear()
    def call(self,method,path,body=None,headers=None):
        c=http.client.HTTPConnection('127.0.0.1',self.http.server_port,timeout=45)
        c.request(method,path,body=body,headers=headers or {});r=c.getresponse();out=r.status,dict(r.getheaders()),r.read();c.close();return out
    def post(self,path,body):return self.call('POST',path,json.dumps(body),self.h)
    def state(self):return json.loads(self.call('GET','/api/state',headers=self.h)[2])
    def wait(self):
        for _ in range(200):
            s=self.state()
            if not s['busy']:
                self.assertFalse(s['error'],s['error']);return s
            time.sleep(.1)
        self.fail('Worker did not finish')
    def start(self,size):
        code,_,data=self.post('/api/uploads',{'size':size});self.assertEqual(code,201);return json.loads(data)['id']
    def chunk(self,id,offset,b):return self.call('PUT','/api/upload-chunk/'+id,b,{**self.h,'X-Upload-Offset':str(offset)})
    def plan(self):
        b=self.fixture.read_bytes();id=self.start(len(b))
        self.assertEqual(self.chunk(id,0,b)[0],200)
        self.assertEqual(self.post('/api/uploads/finish',{'id':id})[0],202);self.wait()
        self.assertEqual(self.post('/api/plan',{'prompt':'15 seconds, cuts only'})[0],202);return self.wait()
    def test_01_chunks_replay_without_duplicating_bytes(self):
        id=self.start(6)
        self.assertEqual(self.chunk(id,0,b'abc')[0],200)
        self.assertEqual(self.chunk(id,0,b'abc')[0],200)
        self.assertEqual(self.chunk(id,0,b'bad')[0],400)
        self.assertEqual(self.chunk(id,3,b'def')[0],200)
        s=self.state();self.assertEqual(s['upload']['received'],6)
        session=next(iter(server.SESSIONS.values()))
        self.assertEqual((session.root/(id+'.mov')).read_bytes(),b'abcdef')
    def test_02_skipped_and_overlapping_offsets_rejected(self):
        id=self.start(10)
        self.assertEqual(self.chunk(id,1,b'x')[0],400)
        self.assertEqual(self.chunk(id,0,b'abc')[0],200)
        self.assertEqual(self.chunk(id,2,b'def')[0],400)
        self.assertEqual(self.post('/api/uploads/finish',{'id':id})[0],400)
    def test_03_cancel_upload_removes_partial_and_unblocks(self):
        id=self.start(8);self.chunk(id,0,b'1234')
        root=next(iter(server.SESSIONS.values())).root
        self.assertEqual(self.post('/api/cancel',{})[0],200)
        self.assertFalse(self.state()['busy']);self.assertIsNone(self.state()['upload'])
        self.assertFalse((root/(id+'.mov')).exists());self.start(1)
    def test_04_upload_reservation_excludes_conflicting_requests(self):
        self.start(5)
        self.assertEqual(self.post('/api/uploads',{'size':4})[0],400)
        self.assertEqual(self.post('/api/plan',{})[0],400)
        self.assertEqual(self.post('/api/clear',{})[0],400)
    def test_05_chunk_bound_and_unknown_id(self):
        id=self.start(server.CHUNK_BYTES+1)
        self.assertEqual(self.call('PUT','/api/upload-chunk/'+id,b'x',{**self.h,'X-Upload-Offset':'0','Content-Length':str(server.CHUNK_BYTES+1)})[0],400)
        self.assertEqual(self.chunk('not-my-upload',0,b'x')[0],400)
    def test_06_real_chunked_upload_and_proxy(self):
        b=self.fixture.read_bytes();id=self.start(len(b))
        for pos in range(0,len(b),7000):self.assertEqual(self.chunk(id,pos,b[pos:pos+7000])[0],200)
        self.assertEqual(self.post('/api/uploads/finish',{'id':id})[0],202)
        s=self.wait();self.assertEqual(len(s['clips']),1);self.assertIsNone(s['upload'])
        c=s['clips'][0];self.assertEqual(c['id'],id)
        self.assertEqual(self.call('GET','/api/poster/'+id,headers=self.h)[1]['Content-Type'],'image/jpeg')
        self.assertEqual(self.call('HEAD','/api/clip/'+id,headers={**self.h,'Range':'bytes=0-1'})[0],206)
    def test_07_saved_crop_mute_and_trim_survive_page_reload(self):
        s=self.plan();moments=copy.deepcopy(s['directed']['plan']['moments'])
        moments[0].update(start=0,duration=.5,focusX=.2,focusY=.7,muted=True)
        self.assertEqual(self.post('/api/review',{'revision':s['revision'],'moments':moments})[0],202)
        fresh=self.wait();m=fresh['directed']['plan']['moments'][0]
        self.assertEqual(m['focusX'],.2);self.assertTrue(m['muted']);self.assertEqual(m['duration'],.5)
        self.assertEqual(self.state()['revision'],fresh['revision'])
    def test_08_old_revision_cannot_overwrite_new_edit(self):
        s=self.plan();payload={'revision':s['revision'],'moments':s['directed']['plan']['moments']}
        self.assertEqual(self.post('/api/review',payload)[0],202);self.wait()
        self.assertEqual(self.post('/api/review',payload)[0],409)
    def test_09_no_implicit_render_approval(self):
        s=self.plan()
        self.assertEqual(self.post('/api/render',{'moments':s['directed']['plan']['moments'],'reviewed':1})[0],400)
    def test_10_locked_crop_requires_explicit_unlock(self):
        s=self.plan();moments=copy.deepcopy(s['directed']['plan']['moments']);moments[0]['locked']=True
        self.assertEqual(self.post('/api/review',{'moments':moments})[0],202);self.wait()
        moments[0]['focusX']=.2
        self.assertEqual(self.post('/api/review',{'moments':moments})[0],400)
        moments[0]['locked']=False
        self.assertEqual(self.post('/api/review',{'moments':moments})[0],202);self.wait()
    def test_11_invalid_rejected_moment_still_rejected_by_validator(self):
        s=self.plan();moments=copy.deepcopy(s['directed']['plan']['moments']);moments[0].update(approved=False,start=999)
        self.assertEqual(self.post('/api/review',{'moments':moments})[0],400)
    def test_12_malformed_json_nonfinite_and_types(self):
        for body in ('{"size":NaN}', '[]','{"size":true}'):
            self.assertEqual(self.call('POST','/api/uploads',body,self.h)[0],400)
        for settings in ({'gentleCleanup':1},{'targetSeconds':True},{'style':[]},{'transitions':'run-command'}):
            with self.assertRaises(engine.TestError):engine.settings_from(settings)
    def test_13_report_has_no_credentials_or_source_identifiers(self):
        self.assertEqual(self.post('/api/feedback',{'wouldShare':True})[0],400)
        code,_,data=self.call('GET','/api/report',headers=self.h);self.assertEqual(code,200)
        for secret in ('csrf','token','fileName','/tmp/'):
            self.assertNotIn(secret,data.decode())
        self.assertIn('not verifiable',data.decode())
    def test_14_health_never_claims_device_or_billing_verification(self):
        d=json.loads(self.call('GET','/api/health')[2])
        self.assertFalse(d['deviceTested']);self.assertFalse(d['billingVerified']);self.assertFalse(d['nativeApp'])
    def test_15_security_headers_and_code_injection_guard(self):
        code,headers,_=self.call('GET','/');self.assertEqual(code,200)
        self.assertIn("script-src 'self'",headers['Content-Security-Policy'])
        self.assertIn('microphone=()',headers['Permissions-Policy'])
        self.assertEqual(self.call('PUT','/api/upload-chunk/fake',b'abc',{**self.h,'Origin':'https://evil.invalid'})[0],403)
    def test_15b_private_proxy_allows_exact_origin_despite_cross_site_metadata(self):
        # Simulates Codespaces proxy metadata without trusting arbitrary origins.
        local=f'http://127.0.0.1:{self.http.server_port}'
        headers={**self.h,'Origin':local,'Sec-Fetch-Site':'cross-site'}
        self.assertEqual(self.call('POST','/api/cancel','{}',headers)[0],200)
        self.assertEqual(self.call('POST','/api/cancel','{}',{**headers,'Origin':'https://evil.invalid'})[0],403)
        self.assertEqual(self.call('POST','/api/cancel','{}',{**self.h,'Sec-Fetch-Site':'cross-site'})[0],403)
        self.assertEqual(self.call('POST','/api/cancel','{}',{**headers,'X-Compass-CSRF':'invalid'})[0],403)

    def test_15c_private_proxy_accepts_its_actual_same_origin_host(self):
        # Some Codespaces proxy routes use a browser host that does not match
        # CODESPACE_NAME. Same-origin requests for the private forwarded port
        # must work, while a different Origin remains blocked.
        host = 'actual-private-test-8765.app.github.dev'
        headers = {**self.h, 'Host': host, 'Origin': f'https://{host}',
                   'Sec-Fetch-Site': 'cross-site'}
        with patch.dict(server.os.environ, {
                'CODESPACE_NAME': 'different-codespace',
                'GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN': 'app.github.dev'}):
            self.assertEqual(self.call('POST','/api/cancel','{}',headers)[0],200)
            self.assertEqual(self.call('POST','/api/cancel','{}',
                             {**headers, 'Origin': 'https://evil.invalid'})[0],403)

    def test_16_untrusted_playlist_is_rejected_before_media_processing(self):
        with tempfile.TemporaryDirectory() as td:
            p=Path(td)/(str(uuid.uuid4())+'.mov');p.write_text('#EXTM3U\n#EXTINF:3,\nfile:///etc/passwd\n')
            with self.assertRaises(engine.TestError):engine.analyze(p,1,threading.Event())
    def test_17_failed_render_cleans_partials_but_keeps_originals(self):
        with tempfile.TemporaryDirectory() as td:
            root=Path(td);(root/'original.mov').write_bytes(b'original')
            def fail(*args):
                (root/'segment-0.mp4').write_bytes(b'partial');(root/'pending.mp4').write_bytes(b'partial')
                raise engine.TestError('Injected test failure')
            with patch.object(engine,'_render',side_effect=fail):
                with self.assertRaises(engine.TestError):engine.render(root,[],{},threading.Event(),lambda *_:None)
            self.assertEqual([p.name for p in root.iterdir()],['original.mov'])
    def test_18_coverage_exposes_missing_sources(self):
        s=self.plan();d=s['directed'];self.assertEqual(d['coverage']['used'],1)
        extra={'id':'not-selected','name':'Clip 2'};engine_result=copy.deepcopy(d)
        self.assertEqual(server.annotate(engine_result,s['clips']+[extra])['coverage']['omitted'],['Clip 2'])

    def test_19_absolute_frame_rounding_does_not_accumulate_drift(self):
        timeline=[];cursor=0
        for i in range(40):
            length=[.373,.541,.267,.713,.423][i%5]
            timeline.append(dict(at=cursor,incoming='cut',overlap=0,moment={'duration':length}))
            cursor+=length
        shots=engine.frame_timeline(timeline)
        self.assertLessEqual(abs(shots[-1]['at']+shots[-1]['moment']['duration']-cursor),1/60+.00001)
        for a,b in zip(shots,shots[1:]):
            self.assertAlmostEqual(a['at']+a['moment']['duration'],b['at'])
    def test_20_chunked_render_feedback_download_and_clear(self):
        s=self.plan()
        self.assertEqual(self.post('/api/render',{'revision':s['revision'],'reviewed':True,'moments':s['directed']['plan']['moments']})[0],202)
        finished=self.wait();self.assertTrue(finished['ready']);self.assertTrue(finished['receipt']['completeDecode'])
        code,headers,data=self.call('GET','/api/download',headers=self.h)
        self.assertEqual(code,200);self.assertIn('attachment',headers['Content-Disposition']);self.assertGreater(len(data),100)
        self.assertEqual(self.post('/api/feedback',{'completePlayback':True,'wouldShare':False})[0],200)
        report=json.loads(self.call('GET','/api/report',headers=self.h)[2]);self.assertFalse(report['userReported']['wouldShare'])
        self.assertNotIn('savedToPhotos',report['userReported'])
        self.assertEqual(self.post('/api/clear',{})[0],200)
        self.assertFalse(any(next(iter(server.SESSIONS.values())).root.iterdir()))

if __name__=='__main__':unittest.main(verbosity=2)
