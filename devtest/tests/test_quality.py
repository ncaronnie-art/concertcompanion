"""Synthetic media only. No production service, accounts, or user footage."""
import array, copy, http.client, json, math, shutil, tempfile, threading, time, unittest, uuid
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import engine, server

class QualityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp=Path(tempfile.mkdtemp(prefix='compass-synthetic-'))
        cls.fixtures=[]
        for color,size,tone in [('red','180x320',440),('blue','320x180',880),('green','180x320',None)]:
            path=cls.temp/(color+'.mp4')
            args=['-f','lavfi','-i',f'color={color}:s={size}:r=30:d=4']
            if tone: args+=['-f','lavfi','-i',f'sine=frequency={tone}:sample_rate=48000:duration=4']
            args+=['-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-threads','2']
            if tone: args+=['-c:a','aac','-ac','2']
            else: args+=['-an']
            engine.ff(args+['-t','4',str(path)])
            cls.fixtures.append(path)
        server.BASE=cls.temp/'sessions'; server.BASE.mkdir()
        cls.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        threading.Thread(target=cls.http.serve_forever,daemon=True).start()
    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown(); cls.http.server_close(); shutil.rmtree(cls.temp)
    def setUp(self):
        self.root=Path(tempfile.mkdtemp(dir=self.temp)); self.cancel=threading.Event()
    def tearDown(self): shutil.rmtree(self.root,ignore_errors=True)
    def clip(self,i):
        p=self.root/(str(uuid.uuid4()).upper()+'.mov');shutil.copyfile(self.fixtures[i],p)
        return engine.analyze(p,i+1,self.cancel)
    def manual(self,clips,transition='cuts',cleanup=False):
        settings=engine.settings_from(dict(transitions=transition,gentleCleanup=cleanup))
        directed=engine.direct(self.root,clips,settings,self.cancel)
        moments=[]
        for i,c in enumerate(clips):
            m=copy.deepcopy(directed['plan']['moments'][0]);m.update(id=str(uuid.uuid4()).upper(),clipID=c['id'],start=.1,duration=2,role='hook' if i==0 else 'end')
            moments.append(m)
        directed['plan']['moments']=moments
        return engine.direct(self.root,clips,settings,self.cancel,plan=directed['plan'])
    def frequency(self,path,t):
        raw=engine.ff(['-ss',str(t)]+engine.inp(path)+['-t','0.4','-vn','-ac','1','-ar','16000','-f','f32le','pipe:1'])
        a=array.array('f');a.frombytes(raw)
        return sum(a[i]<=0<a[i+1] for i in range(len(a)-1))/(len(a)/16000)
    def test_a_native_core_prompt_and_cli_reused(self):
        c=self.clip(0)
        d=engine.direct(self.root,[c],engine.settings_from({'prompt':'15 seconds, cinematic, soft transitions'}),self.cancel)
        self.assertEqual(d['plan']['settings']['style'],'cinematic')
        self.assertEqual(d['plan']['settings']['transitions'],'dissolves')
        self.assertTrue(d['timeline']); self.assertTrue(c['audio']); self.assertTrue(c['visual'])
    def test_b_cuts_full_video_picture_and_audio(self):
        clips=[self.clip(0),self.clip(1)];d=self.manual(clips)
        output=engine.render(self.root,clips,d,self.cancel,lambda *_:None)
        self.assertAlmostEqual(float(engine.probe(output)['format']['duration']),4,delta=.1)
        for t,channel,tone in [(.4,0,440),(3,2,880)]:
            pixel=engine.ff(['-ss',str(t)]+engine.inp(output)+['-frames:v','1','-vf','scale=1:1','-an','-pix_fmt','rgb24','-f','rawvideo','pipe:1'])
            self.assertGreater(pixel[channel],180)
            self.assertAlmostEqual(self.frequency(output,t),tone,delta=8)
        self.assertEqual([p.name for p in self.root.iterdir()],['reel.mp4'])
    def test_c_dissolves_and_rumble_cleanup(self):
        clips=[self.clip(0),self.clip(1)];d=self.manual(clips,'dissolves',True)
        output=engine.render(self.root,clips,d,self.cancel,lambda *_:None)
        self.assertAlmostEqual(float(engine.probe(output)['format']['duration']),3.68,delta=.1)
        self.assertAlmostEqual(self.frequency(output,3),880,delta=8)
    def test_d_silent_source_and_mixed_sources(self):
        clips=[self.clip(0),self.clip(2)];self.assertFalse(clips[1]['hasAudio'])
        output=engine.render(self.root,clips,self.manual(clips),self.cancel,lambda *_:None)
        self.assertAlmostEqual(self.frequency(output,3),0,delta=1)
    def test_e_cancel_does_not_publish(self):
        clips=[self.clip(0)];d=self.manual(clips);self.cancel.set()
        with self.assertRaises(engine.TestError): engine.render(self.root,clips,d,self.cancel,lambda *_:None)
        self.assertFalse((self.root/'reel.mp4').exists())
    def test_f_invalid_trim_blocked_by_core(self):
        clips=[self.clip(0)];d=self.manual(clips);d['plan']['moments'][0]['start']=90
        with self.assertRaises(engine.TestError):engine.direct(self.root,clips,d['plan']['settings'],self.cancel,plan=d['plan'])
    def test_g_unsupported_prompt_stabilization_not_faked(self):
        clips=[self.clip(0)]
        with self.assertRaises(engine.TestError): engine.direct(self.root,clips,engine.settings_from({'prompt':'stabilize'}),self.cancel)
    def call(self,method,path,body=None,headers=None):
        conn=http.client.HTTPConnection('127.0.0.1',self.http.server_port,timeout=30)
        conn.request(method,path,body=body,headers=headers or {});r=conn.getresponse();data=r.read();meta=dict(r.getheaders());code=r.status;conn.close();return code,meta,data
    def session(self):
        code,meta,data=self.call('GET','/api/state');self.assertEqual(code,200)
        state=json.loads(data);return {'Cookie':meta['Set-Cookie'].split(';')[0],'X-Compass-CSRF':state['csrf'],'Content-Type':'application/json'}
    def wait(self,h):
        for _ in range(180):
            _,_,data=self.call('GET','/api/state',headers=h);s=json.loads(data)
            if not s['busy']:
                self.assertFalse(s['error'],s['error']);return s
            time.sleep(.15)
        self.fail('Background test did not complete')
    def test_h_http_upload_plan_render_range_clear(self):
        h=self.session()
        for p in self.fixtures[:2]:
            code,_,_=self.call('PUT','/api/upload',p.read_bytes(),h);self.assertEqual(code,202);self.wait(h)
        code,_,_=self.call('POST','/api/plan',json.dumps({'prompt':'15 seconds cuts only'}),h);self.assertEqual(code,202)
        s=self.wait(h);moments=s['directed']['plan']['moments']
        code,_,_=self.call('POST','/api/render',json.dumps(dict(reviewed=True,moments=moments)),h);self.assertEqual(code,202);s=self.wait(h);self.assertTrue(s['ready'])
        code,meta,data=self.call('GET','/api/reel',headers={**h,'Range':'bytes=0-99'});self.assertEqual(code,206);self.assertEqual(len(data),100);self.assertIn('Content-Range',meta)
        self.assertEqual(self.call('GET','/api/reel',headers={**h,'Range':'bytes=999999999-'} )[0],416)
        self.assertEqual(self.call('GET','/api/reel')[0],401)
        self.assertEqual(self.call('POST','/api/clear','{}',h)[0],200)
        self.assertEqual(self.call('GET','/api/reel',headers=h)[0],404)
    def test_i_security_and_size_guards(self):
        h=self.session()
        self.assertEqual(self.call('GET','/',headers={'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate'})[0],200)
        self.assertEqual(self.call('GET','/api/state',headers={'Sec-Fetch-Site':'cross-site'})[0],403)
        self.assertEqual(self.call('POST','/api/clear','{}')[0],403)
        self.assertEqual(self.call('GET','/api/state',headers={'Origin':'https://attacker.invalid'})[0],403)
        self.assertEqual(self.call('GET','/api/state',headers={'Host':'attacker.invalid'})[0],403)
        self.assertEqual(self.call('GET','/../native/ConcertCompass/Package.swift')[0],401)
        self.assertEqual(self.call('PUT','/api/upload',b'x',{**h,'Content-Length':str(server.MAX_UPLOAD+1)})[0],400)
    def test_j_hevc_main10_and_hdr_tonemap(self):
        path=self.root/(str(uuid.uuid4()).upper()+'.mov')
        engine.ff(['-f','lavfi','-i','testsrc2=size=180x320:rate=30:duration=3','-c:v','libx265',
                   '-preset','ultrafast','-threads','2','-x265-params','pools=1:frame-threads=1:log-level=error:colorprim=9:transfer=16:colormatrix=9',
                   '-pix_fmt','yuv420p10le','-tag:v','hvc1','-color_primaries','bt2020','-color_trc','smpte2084','-colorspace','bt2020nc',str(path)])
        self.assertEqual(engine.probe(path)['streams'][0].get('color_transfer'),'smpte2084')
        c=engine.analyze(path,1,self.cancel)
        output=engine.render(self.root,[c],self.manual([c]),self.cancel,lambda *_:None)
        info=engine.probe(output);v=next(s for s in info['streams'] if s['codec_type']=='video')
        self.assertEqual(v['codec_name'],'h264');self.assertEqual(v['color_transfer'],'bt709')
    def test_k_locked_ranges_are_preserved(self):
        clips=[self.clip(0),self.clip(1)];d=self.manual(clips);d['plan']['moments'][0]['locked']=True
        r=engine.direct(self.root,clips,d['plan']['settings'],self.cancel,previous=d['plan'])
        self.assertEqual(d['plan']['moments'][0],r['plan']['moments'][0])
    def test_l_fifteen_second_multishot_dissolve(self):
        clips=[]
        for i in range(2):
            path=self.root/(str(uuid.uuid4()).upper()+'.mov')
            engine.ff(['-stream_loop','2']+engine.inp(self.fixtures[i])+['-t','12','-c','copy',str(path)])
            clips.append(engine.analyze(path,i+1,self.cancel))
        d=engine.direct(self.root,clips,engine.settings_from({'prompt':'15 seconds cinematic soft transitions'}),self.cancel)
        self.assertGreater(len(d['timeline']),3)
        output=engine.render(self.root,clips,d,self.cancel,lambda *_:None)
        self.assertAlmostEqual(float(engine.probe(output)['format']['duration']),15,delta=.16)
    def test_m_cleanup_expired_session(self):
        with server.SESSIONS_LOCK:
            sessions=list(server.SESSIONS.values())
            for s in sessions:s.created-=server.TTL+1
        server.reap();self.assertTrue(all(not s.root.exists() for s in sessions));self.assertFalse(server.SESSIONS)

if __name__=='__main__':unittest.main(verbosity=2)
