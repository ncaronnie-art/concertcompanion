"""Shipped catalog handlers in Chromium; generated files, no private media.

Most cases mock HTTP to isolate browser state. The final case uses the real
private handler, FFmpeg analysis, Swift planning and export cleanup.
"""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import engine
import server
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None

ROOT = Path(__file__).resolve().parents[1]
MIB = 1024**2


def initial_state():
    return dict(csrf='generated-catalog-session', revision=0, busy=False, ready=False,
                clips=[], sourceBytes=0, directed=None, receipt=None, feedback={}, upload=None,
                previewReady=False, expiresIn=3600, status='Choose sources', progress=0, error='',
                limits=dict(clips=3, bytesPerClip=750*MIB, projectBytes=2*1024**3,
                            secondsPerClip=300, chunkBytes=2*MIB))


@unittest.skipUnless(sync_playwright, 'Playwright is required for catalog browser checks')
class LocalCatalogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='compass-generated-catalog-')
        cls.fixture = Path(cls.temp.name)/'generated.mov'
        engine.ff(['-f','lavfi','-i','color=c=blue:s=90x160:r=30:d=1',
                   '-f','lavfi','-i','sine=frequency=440:duration=1:sample_rate=48000',
                   '-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p',
                   '-c:a','aac','-ac','2','-t','1',str(cls.fixture)])
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(executable_path='/usr/bin/chromium',
                                                    headless=True, args=['--no-sandbox'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()
        cls.temp.cleanup()

    def setUp(self):
        self.page = self.browser.new_page(viewport={'width':390,'height':844})
        self.page_errors = []
        self.page.on('pageerror', lambda error: self.page_errors.append(str(error)))

        def static(route):
            name = route.request.url.rsplit('/',1)[-1].split('#')[0] or 'index.html'
            types = {'index.html':'text/html','app.js':'text/javascript','style.css':'text/css'}
            if name not in types:
                route.fulfill(status=404, body='')
            else:
                route.fulfill(content_type=types[name], body=(ROOT/'static'/name).read_text())

        self.page.route('http://catalog.test/**', static)
        self.page.add_init_script('window.mockInitialState = '+json.dumps(initial_state())+';')
        self.page.add_init_script("""(() => {
          window.serverState = structuredClone(window.mockInitialState);
          window.requests = []; window.chunkBodies = []; window.failUpload = '';
          window.createdURLs = []; window.revokedURLs = [];
          const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
          URL.createObjectURL = file => {const url=create(file);createdURLs.push(url);return url;};
          URL.revokeObjectURL = url => {revokedURLs.push(url);return revoke(url);};
          const actualFetch = window.fetch.bind(window);
          let serial=0;
          window.fetch = async (url, options={}) => {
            if (!String(url).startsWith('/api/')) return actualFetch(url, options);
            const reply=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
            if (url==='/api/state') return reply(serverState);
            const body=typeof options.body==='string'?JSON.parse(options.body):null;
            requests.push({url,body});
            if (url==='/api/uploads') {
              if(failUpload)return reply({error:failUpload},400);
              serverState.upload={id:'source-'+(++serial),size:body.size,received:0};
              return reply({...serverState.upload,chunkBytes:2097152});
            }
            if (String(url).startsWith('/api/upload-chunk/')) {
              chunkBodies.push(await options.body.text());serverState.upload.received+=options.body.size;
              return reply(serverState.upload);
            }
            if (url==='/api/uploads/finish') {
              serverState.clips.push({id:body.id,name:'Clip '+serial,duration:1,width:90,height:160,hasAudio:true});
              serverState.sourceBytes+=serverState.upload.size;serverState.upload=null;
              serverState.revision++;serverState.previewReady=false;return reply({ok:true});
            }
            if (url==='/api/review') {
              if (body.revision!==serverState.revision)return reply({error:'revision conflict'},409);
              serverState.directed.plan.moments=body.moments;
              serverState.revision++;serverState.previewReady=false;return reply({ok:true});
            }
            if (url==='/api/clear') {
              serverState={...structuredClone(mockInitialState),revision:serverState.revision+1};return reply({ok:true});
            }
            if (url==='/api/cancel') {serverState.upload=null;return reply({ok:true});}
            return reply({error:'unexpected mock request'},400);
          };
        })();""")
        self.page.goto('http://catalog.test/')
        self.page.wait_for_function("!document.getElementById('files').disabled")

    def tearDown(self):
        self.page.close()
        self.assertEqual(self.page_errors, [])

    def index(self, count=1, names=None):
        self.page.locator('#files').set_input_files([
            dict(name=name, mimeType='video/mp4', buffer=('generated-'+str(i)).encode())
            for i,name in enumerate(names or [f'source-{i}.mp4' for i in range(count)])])

    def test_many_references_are_local_paged_and_zip_is_not_supported(self):
        self.index(names=[f'source-{i}.mp4' for i in range(58)]+['variant.MOV','variant.MP4','batch.zip','<b>name</b>.mp4'])
        self.assertIn('61 local indexed', self.page.locator('#catalogSummary').inner_text())
        self.assertEqual(self.page.locator('.catalog-entry').count(),25)
        self.assertIn('ZIP extraction is not supported',self.page.locator('#catalogNotice').inner_text())
        self.assertEqual(self.page.evaluate('requests.length'),0)
        self.assertEqual(self.page.evaluate('createdURLs.length'),0)
        self.page.locator('#catalogNext').click()
        self.assertIn('Page 2 of 3',self.page.locator('#catalogPage').inner_text())
        self.page.locator('#catalogNext').click()
        self.assertEqual(self.page.locator('.catalog-entry').count(),11)
        self.assertEqual(self.page.locator('.catalog-entry b b').count(),0)
        self.assertEqual(self.page.evaluate('catalog.filter(e=>e.file.name.startsWith("variant")).length'),2)

    def test_reselection_preserves_reference_and_exclusion_without_assuming_duplicates(self):
        self.page.evaluate("window.originalFile=new File(['original'], 'same.mov', {lastModified:7});addCatalogFiles([originalFile]);")
        self.page.get_by_role('button',name='Exclude from rotation',exact=True).click()
        self.page.evaluate("addCatalogFiles([new File(['different'], 'same.mov', {lastModified:7})]);")
        # Different size is a separate source, not a duplicate.
        self.assertEqual(self.page.evaluate('catalog.length'),2)
        self.page.evaluate("addCatalogFiles([new File(['changed!'], 'same.mov', {lastModified:7})]);")
        self.assertEqual(self.page.evaluate('catalog.length'),2)
        self.assertTrue(self.page.evaluate('catalog[0].excluded && catalog[0].file===originalFile'))
        self.assertIn('not proof of duplicates',self.page.locator('#catalogNotice').inner_text())
        self.page.locator('#catalogMatches').click()
        self.assertEqual(self.page.evaluate('catalog.length'),3)
        self.page.locator('.catalog-entry').first.get_by_role('button',name='Restore to rotation').click()
        self.assertFalse(self.page.evaluate('catalog[0].excluded'))
        self.assertEqual(self.page.evaluate('requests.length'),0)

    def test_choose_and_activate_is_bounded_and_analysis_is_explicit(self):
        self.index(6)
        self.page.locator('.catalog-entry').nth(1).get_by_role('button',name='Exclude from rotation').click()
        self.page.locator('#chooseCatalog').click()
        self.assertIn('import order, not by musical quality',self.page.locator('#catalogNotice').inner_text())
        self.assertEqual(self.page.evaluate('requests.length'),0)
        self.page.locator('#activateCatalog').click()
        self.page.wait_for_function('!running && state.clips.length===3')
        self.assertEqual(self.page.evaluate('chunkBodies'),['generated-0','generated-2','generated-3'])
        self.assertIn('3 analyzed in this test · 0 included',self.page.locator('#catalogSummary').inner_text())
        self.assertEqual(self.page.evaluate('requests.filter(r=>r.url==="/api/uploads").length'),3)
        self.assertTrue(self.page.locator('#chooseCatalog').is_disabled())
        self.assertEqual(self.page.evaluate('catalog.length'),6)
        self.assertTrue(self.page.locator('.catalog-entry').first.get_by_role('button',name='Exclude from rotation').is_disabled())

    def test_active_count_bytes_empty_and_long_source_limits_do_not_reject_indexing(self):
        self.index(4)
        self.page.evaluate('catalog.forEach(e=>e.selected=true);renderCatalog()')
        self.page.locator('#activateCatalog').click()
        self.page.wait_for_function('!running')
        self.assertIn('At most 3 active',self.page.locator('#error').inner_text())
        self.assertEqual(self.page.evaluate('requests.length'),0)
        self.page.evaluate("""catalog.forEach(e=>e.selected=false);
          Object.defineProperty(catalog[0].file,'size',{value:751*1024**2});
          Object.defineProperty(catalog[1].file,'size',{value:0});
          catalog[2].duration=345.7333;renderCatalog();""")
        self.assertEqual(self.page.evaluate('catalog.length'),4)
        for index in (0,1,2):
            self.assertTrue(self.page.locator('.catalog-entry').nth(index).locator('input').is_disabled())
        self.page.locator('#chooseCatalog').click()
        self.assertEqual(self.page.evaluate('catalogSelected().map(e=>e.file.name)'),['source-3.mp4'])
        self.page.evaluate("""serverState.clips=[{id:'existing',name:'Existing',duration:1,hasAudio:true}];
          serverState.sourceBytes=1500*1024**2;
          Object.defineProperty(catalog[3].file,'size',{value:600*1024**2});""")
        self.page.evaluate('refresh()')
        self.page.locator('#activateCatalog').click()
        self.assertIn('2 GiB',self.page.locator('#error').inner_text())
        self.assertEqual(self.page.evaluate('requests.length'),0)

    def test_exact_project_quota_and_missing_accounting_are_checked(self):
        self.index(3)
        result=self.page.evaluate("""() => {
          [700,700,648].forEach((m,i)=>Object.defineProperty(catalog[i].file,'size',{value:m*1024**2,configurable:true}));
          checkCatalogActivation(catalog);
          Object.defineProperty(catalog[2].file,'size',{value:648*1024**2+1});
          try {checkCatalogActivation(catalog);return 'missed';} catch(e){return e.message;}
        }""")
        self.assertIn('2 GiB',result)
        self.page.evaluate("state.clips=[{id:'existing'}];delete state.sourceBytes")
        self.assertIn('byte count',self.page.evaluate("() => {try {checkCatalogActivation([catalog[0]]);}catch(e){return e.message;}}"))
        self.assertEqual(self.page.evaluate('requests.length'),0)

    def test_server_quota_rejection_retains_local_files_and_selections(self):
        self.index(1)
        self.page.evaluate("window.failUpload='Not enough private workspace';window.keptFile=catalog[0].file")
        self.page.locator('#chooseCatalog').click();self.page.locator('#activateCatalog').click()
        self.page.wait_for_function('!running')
        self.assertIn('Not enough private workspace',self.page.locator('#error').inner_text())
        self.assertTrue(self.page.evaluate('catalog[0].selected && catalog[0].file===keptFile'))
        self.assertEqual(self.page.evaluate('chunkBodies.length'),0)

    def test_session_binding_never_marks_a_local_reference_as_another_sessions_source(self):
        self.index(1)
        self.page.locator('#chooseCatalog').click();self.page.locator('#activateCatalog').click()
        self.page.wait_for_function('!running && state.clips.length===1')
        self.assertTrue(self.page.evaluate('catalogActive(catalog[0])'))
        self.page.evaluate("serverState.csrf='different-session';serverState.revision=0;serverState.sourceBytes=0;serverState.clips=[]")
        self.page.evaluate('refresh()')
        self.assertFalse(self.page.evaluate('catalogActive(catalog[0])'))
        self.assertEqual(self.page.evaluate('catalog.length'),1)
        self.assertIn('not analyzed in this test',self.page.locator('.catalog-entry').inner_text())

    def test_pending_output_choices_block_activation_without_overwriting_them(self):
        self.index(1)
        self.page.evaluate("""serverState.directed={plan:{settings:{mode:'highlight',style:'memory',targetSeconds:15,
          transitions:'automatic',gentleCleanup:false,preserveSections:false,prompt:''},moments:[],warnings:[],director:''},seconds:0};
          serverState.revision++;""")
        self.page.evaluate('refresh()')
        self.page.locator('#length').select_option('30')
        self.page.locator('#chooseCatalog').click();self.page.locator('#activateCatalog').click()
        self.page.wait_for_function('!running')
        self.assertIn('pending output settings',self.page.locator('#error').inner_text())
        self.assertEqual(self.page.locator('#length').input_value(),'30')
        self.assertEqual(self.page.evaluate('requests.length'),0)

    def test_local_watch_revokes_url_and_preserves_original_bytes(self):
        before=hashlib.sha256(self.fixture.read_bytes()).hexdigest()
        self.page.locator('#files').set_input_files(str(self.fixture))
        self.page.get_by_role('button',name='Watch locally').click()
        self.page.wait_for_function('catalog[0].duration===1')
        self.page.keyboard.press('Escape')
        self.page.wait_for_function('localPreviewURL===null')
        self.assertEqual(self.page.evaluate('createdURLs.length'),1)
        self.assertEqual(self.page.evaluate('revokedURLs'),self.page.evaluate('createdURLs'))
        self.assertEqual(self.page.evaluate('requests.length'),0)
        self.assertEqual(hashlib.sha256(self.fixture.read_bytes()).hexdigest(),before)

    def test_navigation_reload_and_session_cleanup_are_distinct_from_catalog(self):
        self.index(2)
        self.page.locator('.catalog-entry').first.get_by_role('button',name='Exclude from rotation').click()
        self.page.evaluate("location.hash='review'")
        self.assertTrue(self.page.evaluate('catalog[0].excluded'))
        self.page.evaluate("window.kept=catalog.map(e=>e.file);serverState.ready=true;serverState.receipt={width:720,height:1280,seconds:1,moments:1,profile:'generated'}")
        self.page.evaluate('refresh()')
        self.assertTrue(self.page.locator('#catalogList').is_visible())
        self.page.locator('#clear').click();self.page.locator('#clearConfirmButton').click()
        self.page.wait_for_function('!running && !state.ready')
        self.assertTrue(self.page.evaluate('catalog[0].excluded && catalog.every((e,i)=>e.file===kept[i])'))
        self.page.reload();self.page.wait_for_function('state!==null')
        self.assertEqual(self.page.evaluate('catalog.length'),0)
        self.assertIn('requires reselecting files and exclusions',self.page.locator('.upload-card').inner_text())

    def test_catalog_cap_and_failed_activation_do_not_bypass_review(self):
        self.page.evaluate("addCatalogFiles(Array.from({length:501},(_,i)=>new File(['x'],`generated-${i}.mp4`)))")
        self.assertEqual(self.page.evaluate('catalog.length'),500)
        self.assertEqual(self.page.locator('.catalog-entry').count(),25)
        self.assertIn('1 not indexed',self.page.locator('#catalogNotice').inner_text())
        self.page.evaluate('staleDraft=true;show()')
        self.assertTrue(self.page.locator('#activateCatalog').is_disabled())
        self.assertTrue(self.page.locator('#chooseCatalog').is_disabled())
        self.assertEqual(self.page.evaluate('requests.length'),0)

    def test_real_activation_preview_export_retains_local_original_and_catalog(self):
        original=hashlib.sha256(self.fixture.read_bytes()).hexdigest()
        old_base=server.BASE
        with tempfile.TemporaryDirectory(prefix='compass-generated-catalog-http-') as temp:
            server.BASE=Path(temp);server.SESSIONS.clear()
            http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
            threading.Thread(target=http.serve_forever,daemon=True).start()
            page=self.browser.new_page()
            def wait_real(expression):
                # The real server forbids unsafe-eval. Poll through Playwright's
                # evaluation API, without weakening CSP for this integration test.
                deadline=time.monotonic()+60
                while time.monotonic()<deadline:
                    if page.evaluate(expression):
                        return
                    time.sleep(.05)
                self.fail('Real browser job did not finish: '+page.locator('#error').inner_text())
            try:
                page.goto(f'http://127.0.0.1:{http.server_port}/')
                wait_real('state!==null')
                page.locator('#files').set_input_files(str(self.fixture))
                self.assertEqual(page.evaluate('state.clips.length'),0)
                page.get_by_role('button',name='Watch locally').click()
                wait_real('catalog[0].duration===1')
                page.keyboard.press('Escape')
                wait_real('localPreviewURL===null')
                page.locator('#chooseCatalog').click();page.locator('#activateCatalog').click()
                wait_real('!running && state.clips.length===1')
                self.assertEqual(page.evaluate('state.sourceBytes'),self.fixture.stat().st_size)
                page.locator('#preserveSections').check();page.locator('#plan').click()
                wait_real('!running && state.previewReady')
                self.assertIn('1 included in saved edit',page.locator('#catalogSummary').inner_text())
                page.locator('#reviewed').check();page.locator('#render').click()
                wait_real('!running && state.ready')
                session=next(iter(server.SESSIONS.values()))
                self.assertEqual([p.name for p in session.root.iterdir()],['reel.mp4'])
                self.assertEqual(page.evaluate('catalog.length'),1)
                self.assertTrue(page.locator('#catalogList').is_visible())
                local_hash=page.evaluate("""async () => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await catalog[0].file.arrayBuffer())),x=>x.toString(16).padStart(2,'0')).join('')""")
                self.assertEqual(local_hash,original)
                self.assertEqual(hashlib.sha256(self.fixture.read_bytes()).hexdigest(),original)
            finally:
                page.close();http.shutdown();http.server_close();server.SESSIONS.clear();server.BASE=old_base


if __name__ == '__main__':
    unittest.main(verbosity=2)
