#!/usr/bin/env python3
"""Chromium UI + local HTTP API test via an explicit test-only fetch bridge.

Used when the test browser's network policy blocks local navigation. Does not
change that policy. This is NOT direct browser networking, Codespaces auth,
Safari, an OS share-sheet test, or a real iPhone test. Never ship the bridge.
"""
from pathlib import Path
import argparse, base64, json, re, shutil, sys, tempfile, threading
from http.client import HTTPConnection
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import engine, server
from playwright.sync_api import sync_playwright, expect
p=argparse.ArgumentParser();p.add_argument('--output',required=True);p.add_argument('--chromium',default='/usr/bin/chromium');args=p.parse_args()
evidence=Path(args.output).resolve()
if evidence == engine.HERE.parent or engine.HERE.parent in evidence.parents:
    raise SystemExit('Write test evidence outside the repository.')
evidence.mkdir(parents=True,exist_ok=True)
root=Path(tempfile.mkdtemp(prefix='compass-ui-bridge-'))
server.BASE=root/'sessions';server.BASE.mkdir()
http=server.ThreadingHTTPServer(('127.0.0.1',0),server.Handler)
threading.Thread(target=http.serve_forever,daemon=True).start()
checks=[];errors=[];cookie=''

def backend(_source,request):
    global cookie
    headers=dict(request.get('headers',{}))
    if cookie:headers['Cookie']=cookie
    body=base64.b64decode(request['body']) if request.get('body') is not None else None
    c=HTTPConnection('127.0.0.1',http.server_port,timeout=60)
    try:
        c.request(request['method'],request['path'],body,headers)
        r=c.getresponse();data=r.read();response_headers=dict(r.getheaders())
        if 'Set-Cookie' in response_headers:cookie=response_headers['Set-Cookie'].split(';')[0]
        return {'status':r.status,'headers':response_headers,'body':base64.b64encode(data).decode()}
    finally:c.close()

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
        browser=pw.chromium.launch(executable_path=args.chromium,headless=True,args=['--no-sandbox'])
        page=browser.new_page(viewport={'width':390,'height':844},device_scale_factor=1)
        page.set_default_timeout(30000);page.on('pageerror',lambda e:errors.append(str(e)))
        html=(engine.HERE/'static/index.html').read_text()
        html=re.sub(r'<script[^>]+src="/app.js"[^>]*></script>','',html)
        html=re.sub(r'<link[^>]+href="/style.css"[^>]*>','',html)
        page.set_content(html)
        page.add_style_tag(path=str(engine.HERE/'static/style.css'))
        page.expose_binding('backendRequest',backend)
        page.evaluate('''() => {
            window.fetch=async (path,options={})=>{
                let body=null;
                if(options.body!==undefined){
                    const blob=options.body instanceof Blob ? options.body : new Blob([options.body]);
                    const bytes=new Uint8Array(await blob.arrayBuffer());let s='';
                    for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));
                    body=btoa(s);
                }
                const r=await window.backendRequest({path:String(path),method:options.method||'GET',headers:options.headers||{},body});
                const bytes=Uint8Array.from(atob(r.body),c=>c.charCodeAt(0));
                return new Response(bytes,{status:r.status,headers:r.headers});
            };
        }''')
        page.add_script_tag(path=str(engine.HERE/'static/app.js'))
        expect(page.locator('#files')).to_be_enabled()
        for width in (320,390,1280):
            page.set_viewport_size({'width':width,'height':844})
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'),f'Overflow at {width}'
        checks.append('Actual HTML/CSS has no horizontal overflow at 320, 390 and 1280px')
        page.set_viewport_size({'width':390,'height':844})
        page.screenshot(path=str(evidence/'studio-mobile-home.png'),full_page=True)
        page.locator('#files').set_input_files(fixtures)
        expect(page.locator('.source')).to_have_count(2,timeout=120000)
        expect(page.locator('#plan')).to_be_enabled(timeout=120000)
        checks.append('Actual UI uploaded two synthetic files through the bridged chunk API')
        page.locator('[data-prompt="15 seconds, cinematic, soft transitions"]').click();page.locator('#plan').click()
        expect(page.locator('#review')).to_be_visible(timeout=60000)
        expect(page.locator('#render')).to_be_disabled()
        checks.append('Prompt-to-plan and mandatory review gate operate through real backend')
        page.locator('.moment .edit').first.click()
        page.locator('#focusX').evaluate('(e)=>{e.value=0.25;e.dispatchEvent(new Event("input",{bubbles:true}));}')
        page.locator('#editLock').check();page.locator('#editLock').dispatch_event('input')
        expect(page.locator('#editStart')).to_be_disabled();page.locator('#keepMoment').click()
        page.locator('#save').click();expect(page.locator('#work')).to_be_hidden(timeout=30000)
        # Same refresh function as real load; no navigation is possible here.
        page.evaluate('refresh()')
        page.locator('.moment .edit').first.click()
        expect(page.locator('#focusX')).to_have_value('0.25');expect(page.locator('#editLock')).to_be_checked()
        page.locator('[aria-label="Close moment editor"]').click()
        expect(page.locator('#editor')).not_to_be_visible()
        checks.append('Dialog crop editing, explicit lock and saved-state refresh work')
        page.evaluate('''async()=>{for(const img of document.querySelectorAll('img')){
            const response=await fetch(img.getAttribute('src'));if(response.ok)img.src=URL.createObjectURL(await response.blob());
        }}''')
        page.screenshot(path=str(evidence/'studio-mobile-review.png'),full_page=True)
        page.locator('#reviewed').check();page.locator('#render').click()
        expect(page.locator('#result')).to_be_visible(timeout=180000)
        expect(page.locator('#work')).to_be_hidden(timeout=30000)
        assert page.locator('#error').is_hidden(),page.locator('#error').inner_text()
        # Blob source is test transport only, not a change to shipping app code.
        page.evaluate('''async()=>{const r=await fetch('/api/reel');const b=await r.blob();
            document.getElementById('reel').src=URL.createObjectURL(b);}''')
        page.wait_for_function("document.getElementById('reel').readyState >= 2",timeout=30000)
        duration=page.locator('#reel').evaluate('(v)=>v.duration');assert abs(duration-15)<.16,duration
        page.locator('#reel').evaluate('(v)=>{v.muted=true;v.currentTime=14.4;return v.play();}')
        page.wait_for_function("document.getElementById('reel').ended",timeout=10000)
        checks.append('Generated 15-second file decodes and reaches end in Chromium as a test Blob')
        result=backend(None,{'path':'/api/download','method':'GET'})
        (evidence/'Concert_Compass_Synthetic_Proof.mp4').write_bytes(base64.b64decode(result['body']))
        page.locator('#share').click();expect(page.locator('#share')).to_have_text('Share video / Save Video',timeout=30000)
        checks.append('Actual two-tap file-share preparation code runs; OS sharing remains untested')
        page.locator('#fb-completePlayback').select_option('true');page.locator('#feedbackSave').click()
        expect(page.locator('#feedbackStatus')).to_contain_text('saved',timeout=30000)
        report=backend(None,{'path':'/api/report','method':'GET'})
        receipt=json.loads(base64.b64decode(report['body']));assert 'savedToPhotos' not in receipt['userReported']
        (evidence/'ui-bridge-receipt.json').write_text(json.dumps(receipt,indent=2))
        checks.append('Feedback does not mark untested Photos saving as passed')
        page.screenshot(path=str(evidence/'studio-mobile-result.png'),full_page=True)
        page.on('dialog',lambda d:d.accept());page.locator('#clear').click()
        expect(page.locator('#result')).to_be_hidden(timeout=30000)
        assert not any(server.BASE.rglob('*.mp4')) and not any(server.BASE.rglob('*.mov'))
        checks.append('Delete-test action purges all local media through real backend')
        assert not errors,errors
        browser.close()
    result={'type':'Chromium UI / HTTP API bridge; not direct browser networking or Safari', 'checks':checks,'pageErrors':errors}
    (evidence/'ui-bridge-checks.json').write_text(json.dumps(result,indent=2));print(json.dumps(result,indent=2))
finally:
    http.shutdown();http.server_close();shutil.rmtree(root,ignore_errors=True)
