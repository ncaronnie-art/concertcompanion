"""Single-owner, private Codespaces development test; not a production service."""
from __future__ import annotations
import copy, http.cookies, json, os, re, secrets, shutil, threading, time, uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
import engine

PORT = 8765
BASE = Path('/tmp') / ('concert-compass-quality-' + str(os.getuid()))
SESSIONS = {}
SESSIONS_LOCK = threading.Lock()
MAX_UPLOAD = 160 * 1024**2
MAX_PROJECT = 400 * 1024**2
TTL = 3600

class Session:
    def __init__(self):
        self.token, self.csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        self.root = BASE / uuid.uuid4().hex
        self.root.mkdir(mode=0o700, parents=True)
        self.created = time.monotonic()
        self.lock = threading.RLock()
        self.cancel = threading.Event()
        self.busy = False
        self.progress = 0
        self.status = 'Choose two or three short clips.'
        self.error = ''
        self.clips = []
        self.directed = None
        self.ready = False
        self.bytes = 0

    def state(self):
        with self.lock:
            return dict(csrf=self.csrf, busy=self.busy, progress=self.progress, status=self.status,
                        error=self.error, ready=self.ready,
                        clips=[{k:c[k] for k in ('id','name','duration','hasAudio')} for c in self.clips],
                        directed=self.directed, expiresIn=max(0, int(TTL-(time.monotonic()-self.created))))

    def work(self, fn):
        with self.lock:
            if self.busy: raise engine.TestError('Wait for the current operation or stop it first.')
            self.busy, self.error, self.progress = True, '', 0
            self.cancel.clear()
        def task():
            try: fn()
            except engine.TestError as e:
                with self.lock: self.error = str(e)
            except Exception:
                with self.lock: self.error = 'The test encountered an error. No finished reel was reported. Stop and clear this test.'
            finally:
                with self.lock: self.busy = False
        threading.Thread(target=task,daemon=True).start()

    def update(self, amount, message):
        with self.lock: self.progress, self.status = amount, message


def reap():
    with SESSIONS_LOCK:
        for token,s in list(SESSIONS.items()):
            if time.monotonic()-s.created>TTL:
                s.cancel.set()
                if not s.busy:
                    shutil.rmtree(s.root,ignore_errors=True); del SESSIONS[token]


def start_reaper(stop):
    while not stop.wait(20): reap()


def patch_plan(s, patches):
    updated=copy.deepcopy(s.directed['plan'])
    old={m['id']:m for m in updated['moments']}
    if not isinstance(patches,list) or any(not isinstance(p,dict) for p in patches) or len(patches)!=len(old) or {p.get('id') for p in patches}!=set(old):
        raise engine.TestError('The edit changed. Reload the review before rendering.')
    moments=[]
    for patch in patches:
        m=old[patch['id']]
        for k in ('start','duration','approved','locked'):
            if k in patch: m[k]=patch[k]
        moments.append(m)
    updated['moments']=moments
    return updated


class Handler(BaseHTTPRequestHandler):
    server_version = 'CompassQualityTest'
    def log_message(self,*args): pass  # No media names, prompts, tokens or access logs.

    def _headers(self, status, kind='application/json', length=0, extra=None):
        self.send_response(status)
        for k,v in {'Content-Type':kind,'Content-Length':str(length),'Cache-Control':'no-store',
                    'Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',
                    'Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self' blob:; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
                    'Connection':'close', **(extra or {})}.items(): self.send_header(k,v)
        self.end_headers(); self.close_connection = True

    def send_json(self,data,status=200,extra=None):
        b=json.dumps(data,allow_nan=False).encode(); self._headers(status,length=len(b),extra=extra)
        if self.command!='HEAD': self.wfile.write(b)

    def session(self):
        cookie=http.cookies.SimpleCookie()
        try: cookie.load(self.headers.get('Cookie',''))
        except http.cookies.CookieError: pass
        token=cookie['compass'].value if 'compass' in cookie else ''
        with SESSIONS_LOCK: s=SESSIONS.get(token)
        if s and time.monotonic()-s.created<TTL: return s
        return None

    def guard(self, write=False):
        origin=self.headers.get('Origin')
        name=os.environ.get('CODESPACE_NAME')
        domain=os.environ.get('GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN','app.github.dev')
        allowed={f'http://127.0.0.1:{self.server.server_port}',f'http://localhost:{self.server.server_port}'}
        if name: allowed.add(f'https://{name}-{PORT}.{domain}')
        landing = self.command in ('GET','HEAD') and urlsplit(self.path).path=='/' and self.headers.get('Sec-Fetch-Mode')=='navigate'
        if (self.headers.get('Sec-Fetch-Site')=='cross-site' and not landing) or (origin and origin not in allowed):
            self.send_json({'error':'Cross-site requests are blocked.'},403); return False
        # Host allowlist prevents DNS rebinding against local developer machines.
        if self.headers.get('Host','') not in {urlsplit(x).netloc for x in allowed}:
            self.send_json({'error':'Unrecognized test host.'},403); return False
        if write:
            s=self.session()
            if not s or not secrets.compare_digest(self.headers.get('X-Compass-CSRF',''),s.csrf):
                self.send_json({'error':'Session expired. Reload the private test page.'},403); return False
        return True

    def do_HEAD(self): self.do_GET()
    def do_GET(self):
        try:
            if not self.guard(): return
            path=urlsplit(self.path).path
            static={'/':('index.html','text/html; charset=utf-8'),'/app.js':('app.js','text/javascript'),'/style.css':('style.css','text/css')}
            if path in static:
                file,kind=static[path]; b=(engine.HERE/'static'/file).read_bytes()
                self._headers(200,kind,len(b))
                if self.command!='HEAD': self.wfile.write(b)
                return
            if path=='/api/state':
                reap(); s=self.session(); extra={}
                if not s:
                    with SESSIONS_LOCK:
                        if len(SESSIONS)>=2:
                            self.send_json({'error':'Two test sessions already exist. Return to your original tab.'},429); return
                        s=Session(); SESSIONS[s.token]=s
                    secure='; Secure' if os.environ.get('CODESPACE_NAME') else ''
                    extra={'Set-Cookie':f'compass={s.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={TTL}{secure}'}
                self.send_json(s.state(),extra=extra); return
            s=self.session()
            if not s: self.send_json({'error':'Open your private test session first.'},401); return
            if path=='/api/reel' and s.ready:
                self.media(s.root/'reel.mp4'); return
            if path.startswith('/api/clip/') and not s.ready:
                clip=next((c for c in s.clips if c['id']==path.rsplit('/',1)[-1]),None)
                if clip:
                    self.media((s.root/clip['fileName']).with_suffix('.preview.mp4')); return
            self.send_json({'error':'Not found.'},404)
        except (BrokenPipeError,ConnectionResetError): pass

    def media(self,path):
        if not path.is_file(): self.send_json({'error':'Test media expired or was deleted.'},410); return
        size=path.stat().st_size; start,end=0,size-1; status=200
        request_range=self.headers.get('Range')
        if request_range:
            m=re.fullmatch(r'bytes=(\d*)-(\d*)',request_range)
            if not m or not any(m.groups()): self._headers(416,extra={'Content-Range':f'bytes */{size}'}); return
            if m[1]: start=int(m[1]); end=min(size-1,int(m[2])) if m[2] else size-1
            else: start=max(0,size-int(m[2]))
            if start> end or start>=size: self._headers(416,extra={'Content-Range':f'bytes */{size}'}); return
            status=206
        extra={'Accept-Ranges':'bytes','Content-Disposition':'inline; filename="Concert-Compass-Test.mp4"'}
        if status==206: extra['Content-Range']=f'bytes {start}-{end}/{size}'
        self._headers(status,'video/mp4',end-start+1,extra)
        if self.command=='HEAD': return
        with path.open('rb') as f:
            f.seek(start); left=end-start+1
            while left:
                b=f.read(min(left,65536))
                if not b: break
                self.wfile.write(b); left-=len(b)

    def read_json(self):
        n=int(self.headers.get('Content-Length','0'))
        if n<=0 or n>65536: raise engine.TestError('Invalid request size.')
        self.connection.settimeout(30)
        data=json.loads(self.rfile.read(n))
        if not isinstance(data,dict): raise engine.TestError('Expected a settings object.')
        return data

    def do_POST(self):
        try:
            if not self.guard(write=True): return
            s=self.session(); path=urlsplit(self.path).path
            if path=='/api/cancel': s.cancel.set(); self.send_json({'ok':True}); return
            if path=='/api/clear':
                with s.lock:
                    if s.busy: raise engine.TestError('Stop the running task before deleting its files.')
                    shutil.rmtree(s.root,ignore_errors=True); s.root.mkdir(mode=0o700)
                    s.clips=[]; s.directed=None; s.ready=False; s.bytes=0; s.error=''; s.status='All test media deleted. Delete the Codespace too when finished.'
                self.send_json({'ok':True}); return
            if path=='/api/plan':
                body=self.read_json(); settings=engine.settings_from(body)
                if not s.clips or s.ready: raise engine.TestError('Choose clips before planning. A finished test must be cleared before starting again.')
                def plan():
                    previous=patch_plan(s,body['previousMoments']) if s.directed and body.get('previousMoments') is not None else (s.directed['plan'] if s.directed else None)
                    if previous and any(m['approved'] for m in previous['moments']):
                        engine.direct(s.root,s.clips,previous['settings'],s.cancel,plan=previous)
                    result=engine.direct(s.root,s.clips,settings,s.cancel,previous=previous)
                    with s.lock: s.directed=result; s.status='Review the suggested moments before rendering.'
                s.work(plan); self.send_json({'ok':True},202); return
            if path=='/api/render':
                data=self.read_json()
                if not s.directed or s.ready or data.get('reviewed') is not True: raise engine.TestError('Review and approve your moments first.')
                updated=patch_plan(s,data.get('moments'))
                def render():
                    checked=engine.direct(s.root,s.clips,updated['settings'],s.cancel,plan=updated)
                    engine.render(s.root,s.clips,checked,s.cancel,s.update)
                    with s.lock: s.directed=checked; s.ready=True; s.bytes=0
                s.work(render); self.send_json({'ok':True},202); return
            self.send_json({'error':'Not found.'},404)
        except (engine.TestError,ValueError,TypeError,KeyError) as e: self.send_json({'error':str(e)[:700]},400)
        except (BrokenPipeError,ConnectionResetError): pass

    def do_PUT(self):
        s=None; target=None; claimed=False
        try:
            if not self.guard(write=True): return
            if urlsplit(self.path).path!='/api/upload': self.send_json({'error':'Not found.'},404); return
            s=self.session()
            n=int(self.headers.get('Content-Length','0'))
            if self.headers.get('Transfer-Encoding') or not 0<n<=MAX_UPLOAD: raise engine.TestError('Choose a video smaller than 160 MB.')
            with s.lock:
                if s.busy or s.ready or len(s.clips)>=3: raise engine.TestError('Use up to three clips. Wait for analysis or clear a finished test.')
                if s.bytes+n>MAX_PROJECT or shutil.disk_usage(BASE).free<n+1024**3: raise engine.TestError('Not enough test storage. Clear this test and use smaller clips.')
                s.busy=True; claimed=True; s.cancel.clear(); s.error=''; s.status='Receiving your clip'; s.progress=0
            target=s.root/(str(uuid.uuid4()).upper()+'.mov')
            self.connection.settimeout(45)
            with target.open('wb') as f:
                remaining=n
                while remaining:
                    if s.cancel.is_set(): raise engine.TestError('Upload stopped.')
                    b=self.rfile.read(min(65536,remaining))
                    if not b: raise engine.TestError('Upload interrupted. Retry this clip.')
                    f.write(b); remaining-=len(b)
            with s.lock: s.busy=False; claimed=False
            def analyze(path=target):
                try:
                    s.update(.1,'Analyzing picture and sound; creating a compatible preview')
                    clip=engine.analyze(path,len(s.clips)+1,s.cancel)
                    with s.lock:
                        s.clips.append(clip); s.bytes+=n; s.directed=None; s.status='Clip ready. Add another or plan your reel.'; s.progress=1
                except Exception:
                    path.unlink(missing_ok=True); path.with_suffix('.preview.mp4').unlink(missing_ok=True)
                    raise
            s.work(analyze); self.send_json({'ok':True},202); target=None
        except (engine.TestError,ValueError,OSError) as e:
            if target: target.unlink(missing_ok=True)
            if s and claimed:
                with s.lock: s.busy=False
            try: self.send_json({'error':str(e)[:500]},400)
            except (BrokenPipeError,ConnectionResetError): pass


def main():
    import fcntl
    BASE.mkdir(mode=0o700,parents=True,exist_ok=True)
    lock=(BASE/'server.lock').open('w')
    try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError: raise SystemExit('The private test is already running.')
    # Cleanup from an interrupted previous process. Never touches the repository or Photos.
    for p in BASE.iterdir():
        if p.is_dir(): shutil.rmtree(p)
    if not engine.CLI.is_file(): raise SystemExit('Build the QualityCLI before starting.')
    stop=threading.Event(); threading.Thread(target=start_reaper,args=(stop,),daemon=True).start()
    server=ThreadingHTTPServer(('127.0.0.1',PORT),Handler); server.daemon_threads=True
    print(f'Private development test ready: http://localhost:{PORT}',flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally:
        stop.set(); server.server_close()
        for s in SESSIONS.values(): s.cancel.set()
        # Active workers may still be closing media files; the next start also cleans up.
        for s in SESSIONS.values():
            if not s.busy: shutil.rmtree(s.root,ignore_errors=True)

if __name__=='__main__': main()
