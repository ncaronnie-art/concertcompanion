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

    def test_00_desktop_compilation_limits_preserve_full_song_sections(self):
        self.assertEqual(engine.MAX_CLIP_SECONDS, 300.0)
        self.assertEqual(server.MAX_UPLOAD, 750 * 1024**2)
        self.assertEqual(server.MAX_PROJECT, 2 * 1024**3)
        limits=self.state()['limits']
        self.assertEqual(limits['secondsPerClip'], 300.0)
        self.assertEqual(limits['bytesPerClip'], 750 * 1024**2)
        self.assertEqual(limits['outputBytes'], 350 * 1024**2)
        self.assertIn("version=0.3.0", (Path(engine.HERE) / 'start.sh').read_text())
        self.assertIn("printf '0.3.0\\n'", (Path(engine.HERE) / 'prepare.sh').read_text())

    def test_00b_compilation_targets_and_profiles_require_intent(self):
        for seconds in (15, 30, 45, 60, 90, 120, 180, 300):
            settings=engine.settings_from({'targetSeconds':seconds})
            if seconds > 60:
                self.assertEqual(engine.output_profile(seconds)['width'],720)
                with self.assertRaises(engine.TestError):server.require_compilation_approval(settings,False)
                server.require_compilation_approval(settings,True)
            else:
                self.assertEqual(engine.output_profile(seconds)['width'],1080)
                server.require_compilation_approval(settings,None)
        with self.assertRaises(engine.TestError):engine.settings_from({'targetSeconds':301})
        prompted=dict(plan=dict(settings=dict(targetSeconds=300)))
        with self.assertRaises(engine.TestError):server.require_directed_compilation_approval(prompted,None)
        server.require_directed_compilation_approval(prompted,True)

    def test_00c_five_minute_timeline_keeps_all_one_hundred_twenty_boundaries(self):
        timeline=[]
        for index in range(120):
            timeline.append(dict(at=index*2.5, incoming='cut', overlap=0,
                                 moment=dict(duration=2.5)))
        shots=engine.frame_timeline(timeline)
        self.assertEqual(len(shots),engine.MAX_RENDER_MOMENTS)
        self.assertAlmostEqual(shots[-1]['at']+shots[-1]['moment']['duration'],300)
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
    def plan(self, sources=1):
        b=self.fixture.read_bytes()
        for _ in range(sources):
            id=self.start(len(b))
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
    def test_07b_adding_source_preserves_saved_trims_locks_and_rejections(self):
        s=self.plan();moments=copy.deepcopy(s['directed']['plan']['moments'])
        moments[0].update(start=0,duration=.5,focusX=.2,focusY=.7,locked=True)
        if len(moments)>1: moments[-1]['approved']=False
        self.assertEqual(self.post('/api/review',{'revision':s['revision'],'moments':moments})[0],202)
        saved=self.wait();original=copy.deepcopy(saved['directed']['plan']['moments'])
        b=self.fixture.read_bytes();upload=self.start(len(b))
        self.assertEqual(self.chunk(upload,0,b)[0],200)
        self.assertEqual(self.post('/api/uploads/finish',{'id':upload})[0],202)
        after=self.wait()
        self.assertEqual(after['directed']['plan']['moments'],original)
        self.assertIn('Clip 2',after['directed']['coverage']['omitted'])
        self.assertIn('saved edit is unchanged',after['status'])
    def test_07c_source_addition_preserves_review_without_swift(self):
        # Seed a valid reviewed EDL, then exercise real HTTP upload/analysis.
        # This checks the upload mutation, not Swift planning or rendering.
        session=next(iter(server.SESSIONS.values()))
        clip=dict(id='source-A',name='Clip 1',duration=90,hasAudio=True,width=180,height=320)
        kept=dict(id='chorus',clipID='source-A',start=10,duration=45,approved=True,
                  locked=True,muted=False,focusX=.2,focusY=.7,role='peak',score=.8)
        rejected={**kept,'id':'reject','start':60,'duration':5,'approved':False,'locked':False}
        plan=dict(settings=engine.settings_from({'targetSeconds':60}),moments=[kept,rejected])
        session.clips=[clip]
        session.directed=server.annotate(dict(plan=copy.deepcopy(plan),timeline=[dict(at=0,moment=kept)]),session.clips)
        b=self.fixture.read_bytes();upload=self.start(len(b))
        self.assertEqual(self.chunk(upload,0,b)[0],200)
        self.assertEqual(self.post('/api/uploads/finish',{'id':upload})[0],202)
        after=self.wait()
        self.assertEqual(after['directed']['plan'],plan)
        self.assertEqual(after['directed']['seconds'],45)
        self.assertEqual(after['directed']['coverage']['omitted'],['Clip 2'])
        self.assertEqual(after['revision'],1)

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

    def test_15c_private_proxy_requires_exact_configured_instance(self):
        # Some Codespaces proxy routes use a browser host that does not match
        # CODESPACE_NAME. Same-origin requests for the private forwarded port
        # must work, while a different Origin remains blocked.
        host = 'exact-test-8765.app.github.dev'
        headers = {**self.h, 'Host': 'localhost:'+str(self.http.server_port), 'Origin': f'https://{host}',
                   'Sec-Fetch-Site': 'cross-site'}
        with patch.dict(server.os.environ, {
                'CODESPACE_NAME': 'exact-test',
                'GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN': 'app.github.dev'}):
            self.assertEqual(self.call('POST','/api/cancel','{}',headers)[0],200)
            self.assertEqual(self.call('POST','/api/cancel','{}',
                             {**headers, 'Origin': 'https://other-test-8765.app.github.dev'})[0],403)

    def test_15d_private_proxy_rejects_forwarded_unconfigured_origin(self):
        # The Codespaces proxy can send the browser's private forwarded origin
        # while the backend sees a local Host header. CSRF still guards writes.
        origin = 'https://actual-private-test-8765.app.github.dev'
        headers = {**self.h, 'Origin': origin, 'Sec-Fetch-Site': 'cross-site'}
        with patch.dict(server.os.environ, {
                'CODESPACE_NAME': 'different-codespace',
                'GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN': 'app.github.dev'}):
            self.assertEqual(self.call('POST','/api/cancel','{}',headers)[0],403)
            self.assertEqual(self.call('POST','/api/cancel','{}',
                             {**headers, 'Origin': 'https://evil.invalid'})[0],403)
            self.assertEqual(self.call('POST','/api/cancel','{}',
                             {**headers, 'X-Compass-CSRF': 'invalid'})[0],403)

    def test_15e_exact_https_localhost_requires_session_and_csrf(self):
        host=f'localhost:{self.http.server_port}'
        secure={**self.h,'Host':host,'Origin':f'https://{host}','Sec-Fetch-Site':'cross-site'}
        code,_,data=self.call('POST','/api/uploads',json.dumps({'size':3}),secure)
        self.assertEqual(code,201); upload=json.loads(data)['id']
        chunk_headers={**secure,'X-Upload-Offset':'0'}
        self.assertEqual(self.call('PUT','/api/upload-chunk/'+upload,b'a',chunk_headers)[0],200)
        session=next(iter(server.SESSIONS.values())); source=session.root/(upload+'.mov')
        self.assertEqual(source.read_bytes(),b'a')
        for bad in ({**secure,'X-Compass-CSRF':'bad'}, {k:v for k,v in secure.items() if k!='Cookie'}, {**secure,'Cookie':'compass=other'}):
            self.assertEqual(self.call('POST','/api/uploads',json.dumps({'size':1}),bad)[0],403)
            self.assertEqual(self.call('PUT','/api/upload-chunk/'+upload,b'b',{**bad,'X-Upload-Offset':'1'})[0],403)
            self.assertEqual(source.read_bytes(),b'a')
        for origin in (f'https://localhost:{self.http.server_port+1}','null','https://localhost.evil.invalid','https://evil.invalid'):
            self.assertEqual(self.call('POST','/api/uploads',json.dumps({'size':1}),{**secure,'Origin':origin})[0],403)
        self.assertEqual(self.call('POST','/api/uploads',json.dumps({'size':1}),{k:v for k,v in secure.items() if k!='Origin'})[0],403)
        self.assertEqual(self.call('POST','/api/uploads',json.dumps({'size':1}),{**secure,'Host':'evil.invalid'})[0],403)
        self.assertEqual(self.call('POST','/api/uploads',json.dumps({'size':1}),{**secure,'Origin':'https://evil.invalid','X-Forwarded-Host':'localhost','X-Forwarded-Proto':'https'})[0],403)
        self.assertEqual(self.post('/api/cancel',{})[0],200)

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

    def test_21_wizard_adjustment_preserves_lock_and_exports_current_revision(self):
        b=self.fixture.read_bytes(); upload=self.start(len(b))
        self.assertEqual(self.chunk(upload,0,b)[0],200)
        self.assertEqual(self.post('/api/uploads/finish',{'id':upload})[0],202); self.wait()
        first={
            'revision': self.state()['revision'], 'mode': 'highlight', 'style': 'memory',
            'targetSeconds': 15, 'transitions': 'automatic', 'gentleCleanup': False,
            'prompt': '15 seconds, cinematic', 'explicitSettings': ['targetSeconds', 'style'],
            'wizard': {'preset': 'wizard', 'aspectRatio': '9:16',
                       'audioMode': 'selected-moment-original', 'vibePrompt': 'warm memory'},
        }
        self.assertEqual(self.post('/api/plan',first)[0],202)
        planned=self.wait(); self.assertLess(planned['directed']['seconds'],15)
        self.assertEqual(planned['directed']['plan']['settings']['style'], 'memory')
        self.assertIn('No footage was looped or stretched', ' '.join(planned['directed']['plan']['warnings']))
        moments=copy.deepcopy(planned['directed']['plan']['moments']); moments[0]['locked']=True
        self.assertEqual(self.post('/api/review',{'revision':planned['revision'],'moments':moments})[0],202)
        locked=self.wait(); original=copy.deepcopy(locked['directed']['plan']['moments'][0])
        adjustment={'revision':locked['revision'],'editRequest':'cuts only',
                    'previousMoments':locked['directed']['plan']['moments'],
                    'wizard':locked['directed']['wizard']}
        self.assertEqual(self.post('/api/plan',adjustment)[0],202)
        revised=self.wait(); self.assertEqual(revised['directed']['plan']['settings']['transitions'],'cuts')
        self.assertEqual(revised['directed']['plan']['moments'][0],original)
        self.assertEqual(revised['directed']['wizard']['audioMode'],'selected-moment-original')
        self.assertEqual(self.post('/api/review',{'revision':locked['revision'],'moments':locked['directed']['plan']['moments']})[0],409)
        self.assertEqual(self.post('/api/render',{'revision':revised['revision'],'reviewed':True,
                                                   'moments':revised['directed']['plan']['moments']})[0],202)
        exported=self.wait(); self.assertTrue(exported['ready'])
        self.assertAlmostEqual(exported['receipt']['seconds'],revised['directed']['seconds'],places=2)
        self.assertEqual(self.call('GET','/api/download',headers=self.h)[0],200)

    def test_22_preview_retains_sources_and_stale_export_is_refused(self):
        s=self.plan(); self.assertTrue(s['previewReady'])
        session=next(iter(server.SESSIONS.values()))
        self.assertTrue((session.root/'preview.mp4').is_file())
        self.assertTrue(any(p.suffix == '.mov' for p in session.root.iterdir()))
        self.assertEqual(self.call('GET','/api/preview',headers=self.h)[0],200)
        moments=copy.deepcopy(s['directed']['plan']['moments']); moments[0]['duration']=max(.1,moments[0]['duration']-.1)
        self.assertEqual(self.post('/api/review',{'revision':s['revision'],'moments':moments})[0],202)
        changed=self.wait(); self.assertFalse(changed['previewReady'])
        self.assertEqual(self.call('GET','/api/preview',headers=self.h)[0],404)
        code,_,data=self.post('/api/render',{'revision':changed['revision'],'reviewed':True,'moments':moments})
        self.assertEqual(code,400);self.assertIn('Update preview before export',data.decode())

    def test_24_intact_song_fades_export_reviewed_bytes_with_honest_receipt(self):
        # Real Swift planning, FFmpeg preview and HTTP promotion. The only
        # substituted setting is output resolution to bound generated test cost.
        with patch.object(engine, 'output_profile', return_value=dict(name='synthetic 160x90', width=160, height=90, crf=18)):
            data = self.fixture.read_bytes()
            for _ in range(2):
                identifier = self.start(len(data))
                self.assertEqual(self.chunk(identifier, 0, data)[0], 200)
                self.assertEqual(self.post('/api/uploads/finish', {'id': identifier})[0], 202)
                self.wait()
            current = self.state()
            self.assertEqual(self.post('/api/plan', {'revision': current['revision'], 'preserveSections': True,
                'transitions': 'dissolves', 'explicitSettings': ['transitions'], 'prompt': ''})[0], 202)
            planned = self.wait()
            self.assertEqual(planned['directed']['plan']['settings']['transitions'], 'dissolves')
            self.assertEqual(len(planned['directed']['timeline']), 2)
            session = next(iter(server.SESSIONS.values()))
            preview = (session.root/'preview.mp4').read_bytes()
            # A newly requested transition is not the reviewed soundtrack.
            payload = dict(revision=planned['revision'], reviewed=True, moments=planned['directed']['plan']['moments'])
            self.assertEqual(self.post('/api/render', {**payload, 'transitions': 'cuts'})[0], 400)
            self.assertTrue(all((session.root/c['fileName']).exists() for c in session.clips))
            self.assertEqual(self.post('/api/render', payload)[0], 202)
            finished = self.wait()
            self.assertEqual((session.root/'reel.mp4').read_bytes(), preview)
            transition = finished['receipt']['audioTransition']
            self.assertEqual(transition['mode'], 'in-place-fades')
            self.assertEqual(transition['maxFadeSeconds'], .15)
            self.assertEqual(transition['overlapSeconds'], 0)
            self.assertFalse(transition['addsGain'])
            self.assertEqual(json.loads(self.call('GET', '/api/report', headers=self.h)[2])['receipt']['audioTransition'], transition)

    def test_23_export_only_promotes_the_exact_reviewed_preview(self):
        s=self.plan(sources=2); session=next(iter(server.SESSIONS.values()))
        preview=session.root/'preview.mp4'; source=session.root/session.clips[0]['fileName']
        before=preview.read_bytes(); original=copy.deepcopy(s['directed']['plan']['moments'])
        self.assertGreaterEqual(len(original),2)
        self.assertEqual(self.call('GET',f'/api/preview?revision={s["revision"]}',headers=self.h)[0],200)
        self.assertEqual(self.call('GET',f'/api/preview?revision={s["revision"]+1}',headers=self.h)[0],409)
        trim=copy.deepcopy(original);trim[0]['duration']=max(.1,trim[0]['duration']-.1)
        framing=copy.deepcopy(original);framing[0]['focusX']=.2;framing[0]['muted']=not framing[0]['muted']
        reordered=list(reversed(copy.deepcopy(original)))
        continuous={'preset':'wizard','aspectRatio':'9:16','audioMode':'single-source',
                    'audioClipID':session.clips[1]['id'],'audioStart':0,'vibePrompt':''}
        variants=[{'moments':trim},{'moments':framing},{'moments':reordered},{'moments':original,'style':'hype'},
                  {'moments':original,'wizard':continuous}]
        for extra in variants:
            code,_,data=self.post('/api/render',{'revision':s['revision'],'reviewed':True,**extra})
            self.assertEqual(code,400,data)
            self.assertFalse(session.ready);self.assertTrue(source.exists());self.assertEqual(preview.read_bytes(),before)
            self.assertFalse((session.root/'reel.mp4').exists())
        self.assertEqual(self.post('/api/review',{'revision':s['revision'],'moments':trim,'preview':True})[0],202)
        updated=self.wait();self.assertTrue(updated['previewReady']);self.assertTrue(source.exists())
        self.assertEqual(self.post('/api/render',{'revision':updated['revision'],'reviewed':True,
                                                   'moments':updated['directed']['plan']['moments']})[0],202)
        finished=self.wait();self.assertTrue(finished['ready']);self.assertTrue((session.root/'reel.mp4').exists())

if __name__=='__main__':unittest.main(verbosity=2)
