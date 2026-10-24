"""Explicit adjacent splits: real Swift validation, generated media and Chromium."""
import copy
import hashlib
import http.client
import json
import math
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
import uuid
import wave
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import engine
import server
from devtest.tests.test_intact_sections import clip, moment
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None


class SplitContractTests(unittest.TestCase):
    def setUp(self):
        self.source = clip(300)
        self.original = moment(self.source, .25, 12.345)
        self.original.update(focusX=.2, focusY=.8, muted=True)
        self.session = SimpleNamespace(clips=[self.source], directed=dict(plan=dict(
            settings=engine.settings_from({'preserveSections': True}),
            moments=[self.original], warnings=[], director='Generated')))

    def split(self, offset, id=None):
        return server.split_plan(self.session, id or self.original['id'], offset)

    def test_adjacent_order_endpoints_flags_and_server_id(self):
        before = copy.deepcopy(self.session.directed)
        result = self.split(4.123)['moments']
        left, right = result
        self.assertEqual(left['id'], self.original['id'])
        self.assertNotEqual(right['id'], left['id'])
        uuid.UUID(right['id'])
        self.assertEqual((left['start'], left['duration'], right['start'], right['duration']),
                         (.25, 4.123, 4.373, 8.222))
        self.assertAlmostEqual(right['start']+right['duration'], .25+12.345, places=12)
        self.assertEqual(sum(round(m['duration']*48000) for m in result), round(12.345*48000))
        for child in result:
            for field in ('clipID', 'approved', 'locked', 'muted', 'focusX', 'focusY', 'role', 'score', 'reason'):
                self.assertEqual(child[field], self.original[field])
        self.assertEqual(self.session.directed, before)

    def test_rejected_and_unlocked_choices_are_inherited_without_approval(self):
        self.original.update(approved=False, locked=False, muted=False)
        self.assertTrue(all(not m['approved'] and not m['locked'] and not m['muted']
                            for m in self.split(1)['moments']))

    def test_edge_points_never_create_zero_or_subminimum_ranges(self):
        self.original.update(start=0, duration=.3)
        for point, expected in ((.1, [.1,.2]), (.2, [.2,.1])):
            self.assertEqual([m['duration'] for m in self.split(point)['moments']], expected)
        for point in (0, -.1, .099, .201, .3, 1):
            with self.subTest(point=point), self.assertRaises(engine.TestError):
                self.split(point)
        self.original['duration'] = .2
        self.assertEqual([m['duration'] for m in self.split(.1)['moments']], [.1,.1])
        self.original['duration'] = .199
        with self.assertRaises(engine.TestError):
            self.split(.1)

    def test_numeric_and_unknown_id_rejections_do_not_mutate(self):
        before = copy.deepcopy(self.session.directed)
        for value in (True, False, None, '1', [], {}, float('nan'), float('inf'), 1e308, .10001):
            with self.subTest(value=value), self.assertRaises(engine.TestError):
                self.split(value)
        with self.assertRaises(engine.TestError):
            self.split(1, 'not-an-owned-id')
        self.assertEqual(self.session.directed, before)

    def test_120_limit_counts_rejected_ranges_as_well(self):
        self.session.directed['plan']['moments'] += [moment(self.source, 0, .2, approved=False) for _ in range(118)]
        self.assertEqual(len(self.split(1)['moments']),120)
        self.session.directed['plan']['moments'].append(moment(self.source, 0, .2))
        with self.assertRaisesRegex(engine.TestError, '120'):
            self.split(1)

    def test_highlight_path_is_not_changed_or_silently_converted(self):
        self.session.directed['plan']['settings']['preserveSections'] = False
        with self.assertRaisesRegex(engine.TestError, 'intact'):
            self.split(1)

    def test_regular_review_still_cannot_add_duplicate_or_remove_ids(self):
        children = self.split(1)['moments']
        for proposed in (children, [], [children[1]], [self.original,self.original]):
            with self.assertRaises(engine.TestError):
                server.patch_plan(self.session, proposed)

    def test_fractional_source_lengths_keep_exact_sample_count(self):
        for duration in (94.09,29.096667,24.518333,300/17, .20001041666666667, 300):
            self.original.update(start=0,duration=duration)
            children=self.split(.1)['moments']
            self.assertEqual(sum(round(m['duration']*48000) for m in children),round(duration*48000))
            self.assertAlmostEqual(math.fsum(m['duration'] for m in children),duration,places=12)


class SplitIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not engine.CLI.is_file():
            raise unittest.SkipTest('Actual rebuilt Swift QualityCLI required')
        cls.temp=tempfile.TemporaryDirectory(prefix='compass-generated-split-')
        cls.fixtures=Path(cls.temp.name)
        cls.source=cls.fixtures/(str(uuid.uuid4()).lower()+'.mov')
        engine.ff(['-f','lavfi','-i','testsrc2=s=90x160:r=30:d=2',
                   '-f','lavfi','-i','sine=frequency=523:sample_rate=48000:duration=2',
                   '-c:v','libx264','-preset','ultrafast','-c:a','pcm_s16le','-ac','2',str(cls.source)])
        cls.record=engine.analyze(cls.source,1,threading.Event())
        cls.old_base=server.BASE
        server.BASE=cls.fixtures/'sessions'
        cls.http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
        threading.Thread(target=cls.http.serve_forever,daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown();cls.http.server_close();server.BASE=cls.old_base
        cls.temp.cleanup()

    def call(self,method,path,body=None,headers=None):
        client=http.client.HTTPConnection('127.0.0.1',self.http.server_port,timeout=45)
        client.request(method,path,body=body,headers=headers or {})
        response=client.getresponse();result=response.status,dict(response.getheaders()),response.read()
        client.close();return result

    def post(self,path,body):
        return self.call('POST',path,json.dumps(body),self.headers)

    def state(self):
        return json.loads(self.call('GET','/api/state',headers=self.headers)[2])

    def wait(self, error=False):
        deadline=time.monotonic()+60
        while time.monotonic()<deadline:
            state=self.state()
            if not state['busy']:
                if not error:self.assertFalse(state['error'],state['error'])
                return state
            time.sleep(.02)
        self.fail('Split test worker did not reach terminal state')

    def setUp(self):
        status,headers,data=self.call('GET','/api/state')
        self.assertEqual(status,200)
        state=json.loads(data)
        self.headers={'Cookie':headers['Set-Cookie'].split(';')[0], 'X-Compass-CSRF':state['csrf'], 'Content-Type':'application/json'}
        token=self.headers['Cookie'].split('=',1)[1]
        self.session=server.SESSIONS[token]
        for source in self.fixtures.iterdir():
            if source.is_file():shutil.copyfile(source,self.session.root/source.name)
        self.session.clips=[copy.deepcopy(self.record)]
        self.session.bytes=self.source.stat().st_size
        settings=engine.settings_from({'preserveSections':True,'transitions':'cuts'})
        directed=engine.direct(self.session.root,self.session.clips,settings,threading.Event())
        directed['wizard']=server.wizard_from({})
        self.session.directed=server.annotate(directed,self.session.clips)
        self.session.revision=3;self.session.preview_revision=3
        (self.session.root/'preview.mp4').write_bytes(b'generated-old-preview-marker')
        self.moment=copy.deepcopy(directed['plan']['moments'][0])
        self.source_hash=hashlib.sha256(self.source.read_bytes()).hexdigest()

    def tearDown(self):
        self.post('/api/cancel',{})
        self.wait(error=True)
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(),self.source_hash)
        server.SESSIONS.pop(self.session.token,None)
        shutil.rmtree(self.session.root)

    def split(self,offset=1.125,revision=3):
        response=self.post('/api/split',dict(revision=revision,momentID=self.moment['id'],offset=offset))
        self.assertEqual(response[0],202,response[2])
        return self.wait()

    def test_actual_swift_split_reload_undo_and_preview_identity(self):
        before=copy.deepcopy(self.session.directed)
        fresh=self.split()
        self.assertEqual(fresh['revision'],4)
        self.assertFalse(fresh['previewReady']);self.assertTrue(fresh['canUndoSplit'])
        self.assertEqual(fresh['directed']['seconds'],2)
        children=fresh['directed']['plan']['moments']
        self.assertEqual([m['duration'] for m in children],[1.125,.875])
        self.assertEqual([s['at'] for s in fresh['directed']['timeline']],[0,1.125])
        self.assertEqual([s['overlap'] for s in fresh['directed']['timeline']],[0,0])
        self.assertTrue(all(m['locked'] and m['approved'] for m in children))
        self.assertEqual(self.state()['directed'],fresh['directed'])
        self.assertNotEqual(self.call('GET','/api/preview?revision=3',headers=self.headers)[0],200)
        self.assertEqual(self.post('/api/render',dict(revision=4,reviewed=True,moments=children))[0],400)
        self.assertEqual(self.post('/api/split/undo',{'revision':4})[0],202)
        undone=self.wait()
        self.assertEqual(undone['directed']['plan'],before['plan'])
        self.assertEqual(undone['revision'],5);self.assertFalse(undone['previewReady']);self.assertFalse(undone['canUndoSplit'])
        self.assertEqual(self.post('/api/split/undo',{'revision':5})[0],400)
        self.assertEqual((self.session.root/self.record['fileName']).read_bytes(),self.source.read_bytes())

    def test_required_stale_boolean_revision_replay_and_id_injection(self):
        for rev in (None,2,True,'3'):
            self.assertEqual(self.post('/api/split',dict(revision=rev,momentID=self.moment['id'],offset=1))[0],409)
        self.assertEqual(self.post('/api/split',dict(momentID=self.moment['id'],offset=1))[0],409)
        fresh=self.split()
        replay=self.post('/api/split',dict(revision=3,momentID=self.moment['id'],offset=1))
        self.assertEqual(replay[0],409)
        self.assertEqual(self.state()['directed'],fresh['directed'])
        self.assertEqual(self.post('/api/review',dict(revision=4,moments=[self.moment]))[0],400)

    def test_saved_review_expires_undo_without_relaxing_id_checks(self):
        fresh=self.split()
        moments=fresh['directed']['plan']['moments'];moments[0]['approved']=False
        self.assertEqual(self.post('/api/review',dict(revision=4,moments=moments))[0],202)
        reviewed=self.wait()
        self.assertFalse(reviewed['canUndoSplit'])
        self.assertEqual(self.post('/api/split/undo',dict(revision=reviewed['revision']))[0],400)
        self.assertEqual([m['approved'] for m in reviewed['directed']['plan']['moments']],[False,True])

    def test_cancellation_after_final_validation_cannot_commit_split(self):
        entered,release=threading.Event(),threading.Event()
        before=copy.deepcopy(self.session.directed)
        actual_direct=engine.direct
        def final_measurement(*args,**kwargs):
            checked=actual_direct(*args,**kwargs)
            entered.set()
            if not release.wait(5):raise AssertionError('Cancellation fixture was not released')
            return checked
        with patch.object(engine,'direct',side_effect=final_measurement):
            try:
                self.assertEqual(self.post('/api/split',dict(revision=3,momentID=self.moment['id'],offset=1))[0],202)
                self.assertTrue(entered.wait(5))
                self.assertEqual(self.post('/api/split',dict(revision=3,momentID=self.moment['id'],offset=1))[0],400)
                self.post('/api/cancel',{})
            finally:release.set()
            stopped=self.wait(error=True)
        self.assertEqual(stopped['directed'],before)
        self.assertEqual(stopped['revision'],3);self.assertTrue(stopped['previewReady'])
        self.assertFalse(stopped['canUndoSplit']);self.assertIn('stopped before saving',stopped['error'])

    def test_real_pcm_duration_order_and_unchanged_interiors(self):
        before=copy.deepcopy(self.session.directed)
        policy=engine.AudioPolicy.from_settings(before['plan']['settings'])
        def pcm(directed):
            path=engine.intact_audio(self.session.root,self.session.clips,directed['timeline'],threading.Event(),policy,time.monotonic()+60)
            with wave.open(str(path),'rb') as audio:
                self.assertEqual(audio.getnframes(),96000)
                return audio.readframes(audio.getnframes())
        original=pcm(before)
        after=pcm(self.split()['directed'])
        boundary=round(1.125*48000)
        self.assertEqual(len(after),len(original))
        # Existing cuts add only the declared 5ms de-click ramps at the new join.
        self.assertEqual(after[:(boundary-240)*4],original[:(boundary-240)*4])
        self.assertEqual(after[(boundary+240)*4:],original[(boundary+240)*4:])

    def test_real_preview_retry_export_and_sources_kept_until_export(self):
        fresh=self.split()
        source=self.session.root/self.record['fileName']
        self.assertTrue(source.is_file())
        self.assertEqual(self.post('/api/review',dict(revision=4,moments=fresh['directed']['plan']['moments'],preview=True))[0],202)
        preview=self.wait()
        self.assertTrue(preview['previewReady']);self.assertTrue(source.is_file())
        preview_hash=hashlib.sha256((self.session.root/'preview.mp4').read_bytes()).hexdigest()
        self.assertEqual(self.post('/api/render',dict(revision=preview['revision'],reviewed=True,moments=preview['directed']['plan']['moments']))[0],202)
        final=self.wait();self.assertTrue(final['ready'])
        self.assertEqual(hashlib.sha256((self.session.root/'reel.mp4').read_bytes()).hexdigest(),preview_hash)
        self.assertEqual([p.name for p in self.session.root.iterdir()],['reel.mp4'])

    def test_actual_swift_exact_300_boundary_and_maximum_120(self):
        self.session.clips=[clip(300)]
        original=moment(self.session.clips[0],0,300)
        plan=self.session.directed['plan'];plan['moments']=[original]
        result=server.split_plan(self.session,original['id'],.1)
        checked=engine.direct(self.session.root,self.session.clips,result['settings'],threading.Event(),plan=result)
        self.assertEqual(math.fsum(m['duration'] for m in checked['plan']['moments']),300)
        plan['moments']=[moment(self.session.clips[0],0,.2) for _ in range(119)]
        result=server.split_plan(self.session,plan['moments'][0]['id'],.1)
        checked=engine.direct(self.session.root,self.session.clips,result['settings'],threading.Event(),plan=result)
        self.assertEqual(len(checked['timeline']),120)

    @unittest.skipUnless(sync_playwright,'Chromium Playwright required')
    def test_browser_explicit_point_cancel_repeated_click_reload_and_undo(self):
        with sync_playwright() as playwright:
            browser=playwright.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
            context=browser.new_context(viewport={'width':390,'height':844})
            base=f'http://127.0.0.1:{self.http.server_port}'
            context.add_cookies([dict(name='compass',value=self.session.token,url=base)])
            page=context.new_page();errors=[];page.on('pageerror',lambda error:errors.append(str(error)))
            def wait_page(expression):
                deadline=time.monotonic()+30
                while time.monotonic()<deadline:
                    if page.evaluate(expression):return
                    time.sleep(.03)
                self.fail('Browser did not finish: '+page.locator('#error').inner_text())
            try:
                page.goto(base);wait_page('state!==null')
                page.get_by_role('button',name='Split range',exact=True).click()
                self.assertEqual(page.locator('#splitOffset').input_value(),'')
                page.locator('#splitCancel').click();self.assertEqual(self.state()['revision'],3)
                page.get_by_role('button',name='Split range',exact=True).click();page.keyboard.press('Escape')
                self.assertEqual(self.state()['revision'],3)
                page.get_by_role('button',name='Split range',exact=True).click()
                page.locator('#splitOffset').fill('0.099');page.locator('#splitConfirm').click()
                self.assertIn('0.1s',page.locator('#splitError').inner_text())
                self.assertEqual(self.state()['revision'],3)
                page.locator('#splitOffset').fill('1.125')
                page.evaluate("document.getElementById('splitConfirm').click();document.getElementById('splitConfirm').click()")
                wait_page('!running && state.revision===4')
                self.assertEqual(page.locator('.moment').count(),2)
                self.assertTrue(page.locator('#render').is_disabled());self.assertTrue(page.locator('#preview').is_hidden())
                page.evaluate("location.hash='split-review'");page.reload();wait_page('state?.revision===4')
                self.assertEqual(page.locator('.moment').count(),2)
                page.locator('#undoSplit').click();wait_page('!running && state.revision===5')
                self.assertEqual(page.locator('.moment').count(),1)
                self.assertTrue(page.locator('#undoSplit').is_hidden())
                self.assertEqual(errors,[])
            finally:browser.close()

    @unittest.skipUnless(sync_playwright,'Chromium Playwright required')
    def test_browser_stale_dialog_and_unsaved_choices_do_not_split(self):
        with sync_playwright() as playwright:
            browser=playwright.chromium.launch(executable_path='/usr/bin/chromium',headless=True,args=['--no-sandbox'])
            context=browser.new_context();base=f'http://127.0.0.1:{self.http.server_port}'
            context.add_cookies([dict(name='compass',value=self.session.token,url=base)])
            page=context.new_page()
            try:
                page.goto(base)
                page.get_by_role('button',name='Split range',exact=True).click()
                page.locator('#splitOffset').fill('1')
                self.split()  # Another tab saved first.
                page.locator('#splitConfirm').click()
                deadline=time.monotonic()+10
                while page.evaluate('running') and time.monotonic()<deadline:time.sleep(.03)
                self.assertIn('newer edit',page.locator('#error').inner_text())
                self.assertEqual(self.state()['revision'],4)
                page.reload();page.get_by_role('button',name='Split range',exact=True).first.wait_for()
                page.locator('#length').select_option('30')
                self.assertTrue(page.get_by_role('button',name='Split range',exact=True).first.is_disabled())
                self.assertTrue(page.locator('#undoSplit').is_disabled())
                self.assertEqual(self.state()['revision'],4)
                page.locator('#revertSettings').click()
                page.get_by_role('button',name='Reject',exact=True).first.click()
                self.assertTrue(page.get_by_role('button',name='Split range',exact=True).first.is_disabled())
                self.assertTrue(page.locator('#undoSplit').is_disabled())
            finally:browser.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
