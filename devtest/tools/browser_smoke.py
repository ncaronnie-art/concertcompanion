#!/usr/bin/env python3
"""Local Chromium integration test; does not assert Safari or physical-phone support.

Optional developer dependency: Playwright plus a Chromium binary. No real footage.
Evidence is written to an explicitly supplied folder outside the repository.
"""
from pathlib import Path
import argparse, json, shutil, sys, tempfile, threading
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import engine, server
from playwright.sync_api import sync_playwright, expect

p=argparse.ArgumentParser();p.add_argument('--output',required=True);p.add_argument('--chromium');args=p.parse_args()
evidence=Path(args.output).resolve()
if evidence == engine.HERE.parent or engine.HERE.parent in evidence.parents:
    raise SystemExit('Write test evidence outside the repository.')
evidence.mkdir(parents=True,exist_ok=True)
root=Path(tempfile.mkdtemp(prefix='compass-browser-synthetic-'))
server.BASE=root/'sessions';server.BASE.mkdir()
http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
threading.Thread(target=http.serve_forever,daemon=True).start()
failures=[];checks=[]
try:
    fixtures=[]
    for i,(size,tone) in enumerate([('180x320',440),('320x180',660)]):
        path=root/f'synthetic-{i}.mp4'
        engine.ff(['-f','lavfi','-i',f'testsrc2=size={size}:rate=30:duration=12',
                   '-f','lavfi','-i',f'sine=frequency={tone}:sample_rate=48000:duration=12',
                   '-c:v','libx264','-preset','ultrafast','-threads','2','-pix_fmt','yuv420p',
                   '-c:a','aac','-t','12',str(path)])
        fixtures.append(str(path))
    with sync_playwright() as pw:
        kw={'headless':True,'args':['--no-sandbox']}
        if args.chromium:kw['executable_path']=args.chromium
        browser=pw.chromium.launch(**kw)
        context=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,device_scale_factor=1)
        page=context.new_page();page.set_default_timeout(20000)
        page.on('pageerror',lambda e:failures.append(str(e)))
        page.goto(f'http://127.0.0.1:{http.server_port}/')
        expect(page.locator('#files')).to_be_enabled()
        for width in (320,390,1280):
            page.set_viewport_size({'width':width,'height':844})
            assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth'),f'Horizontal overflow at {width}'
            checks.append(f'No horizontal overflow at {width}px')
        page.set_viewport_size({'width':390,'height':844})
        page.screenshot(path=str(evidence/'studio-mobile-home.png'),full_page=True)
        page.locator('#files').set_input_files(fixtures)
        expect(page.locator('.source')).to_have_count(2,timeout=120000)
        expect(page.locator('#plan')).to_be_enabled(timeout=120000)
        checks.append('Two files uploaded through chunk endpoints and analyzed via actual UI')
        page.locator('[data-prompt="15 seconds, cinematic, soft transitions"]').click()
        page.locator('#plan').click()
        expect(page.locator('#review')).to_be_visible(timeout=60000)
        expect(page.locator('#render')).to_be_disabled()
        checks.append('Prompt produced a reviewable edit; render blocked before approval')
        page.locator('.moment .edit').first.click()
        expect(page.locator('#editor')).to_be_visible()
        page.locator('#focusX').evaluate('(e)=>{e.value=0.25;e.dispatchEvent(new Event("input",{bubbles:true}));}')
        page.locator('#editLock').check();page.locator('#editLock').dispatch_event('input')
        expect(page.locator('#editStart')).to_be_disabled()
        page.locator('#keepMoment').click()
        page.locator('#save').click()
        expect(page.locator('#save')).to_be_disabled(timeout=30000)
        expect(page.locator('#work')).to_be_hidden(timeout=30000)
        page.reload();expect(page.locator('#review')).to_be_visible()
        page.locator('.moment .edit').first.click()
        expect(page.locator('#focusX')).to_have_value('0.25')
        expect(page.locator('#editLock')).to_be_checked()
        page.locator('[aria-label="Close moment editor"]').click()
        expect(page.locator('#editor')).not_to_be_visible()
        checks.append('Manual framing and a lock survived saving and a browser reload')
        page.locator('#review').scroll_into_view_if_needed()
        page.screenshot(path=str(evidence/'studio-mobile-review.png'),full_page=True)
        page.locator('#reviewed').check()
        page.locator('#render').click()
        expect(page.locator('#result')).to_be_visible(timeout=180000)
        expect(page.locator('#work')).to_be_hidden(timeout=30000)
        assert page.locator('#error').is_hidden(),page.locator('#error').inner_text()
        page.locator('#reel').scroll_into_view_if_needed()
        # Locator evaluation is Playwright's protocol API, not string evaluation in
        # page JavaScript.  It remains compatible with the application's strict CSP.
        page.locator('#reel').evaluate('''video => video.readyState >= 2 ? Promise.resolve() :
            new Promise(resolve => video.addEventListener('loadeddata', resolve, {once:true}))''')
        duration=page.locator('#reel').evaluate('(v)=>v.duration')
        assert abs(duration-15)<.16,duration
        page.locator('#reel').evaluate('(v)=>{v.muted=true;v.currentTime=14.4;return v.play();}')
        page.locator('#reel').evaluate('''video => new Promise(resolve =>
            video.addEventListener('ended', resolve, {once:true}))''')
        checks.append('Complete 15-second result decodes and plays to its end in Chromium')
        with page.expect_download() as dl:
            page.locator('#download').click()
        dl.value.save_as(str(evidence/'Concert_Compass_Synthetic_Proof.mp4'))
        checks.append('MP4 downloaded from the real result endpoint')
        page.locator('#share').click()
        expect(page.locator('#share')).to_have_text('Share video / Save Video',timeout=30000)
        checks.append('Two-tap share preparation completed; OS share sheet NOT tested')
        page.locator('#fb-completePlayback').select_option('true')
        page.locator('#feedbackSave').click()
        expect(page.locator('#feedbackStatus')).to_contain_text('saved',timeout=30000)
        response=page.request.get(f'http://127.0.0.1:{http.server_port}/api/report')
        receipt=response.json();(evidence/'browser-test-receipt.json').write_text(json.dumps(receipt,indent=2))
        assert receipt['userReported'].get('savedToPhotos') is None
        checks.append('Feedback remains explicitly untested for Photos save and real-device sound')
        page.locator('#result').scroll_into_view_if_needed()
        page.screenshot(path=str(evidence/'studio-mobile-result.png'),full_page=True)
        page.on('dialog',lambda d:d.accept())
        page.locator('#clear').click()
        expect(page.locator('#result')).to_be_hidden(timeout=30000)
        assert not any(server.BASE.rglob('*.mov')) and not any(server.BASE.rglob('*.mp4'))
        checks.append('Delete-test action removed source, proxy, intermediate and output media')
        assert not failures,failures
        browser.close()
    (evidence/'browser-checks.json').write_text(json.dumps({'browser':'Local Chromium, mobile viewport; NOT an iPhone','checks':checks,'pageErrors':failures},indent=2))
    print(json.dumps({'passed':len(checks),'checks':checks,'pageErrors':failures},indent=2))
finally:
    http.shutdown();http.server_close();shutil.rmtree(root,ignore_errors=True)
