"""Single-owner development harness. No production hosting or billing operations.

All media lives outside the repository. Cookies identify one ephemeral studio;
CSRF + origin/host checks protect writes. GitHub must keep port 8765 private.
"""
from __future__ import annotations
import copy, hashlib, http.cookies, json, math, os, re, secrets, shutil, threading, time, uuid
from decimal import Decimal
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
import engine
from editorial.refine import propose_editorial_refinement

PORT = 8765
VERSION = '0.3.0'
BASE = Path('/tmp') / ('concert-compass-quality-' + str(os.getuid()))
SESSIONS = {}
SESSIONS_LOCK = threading.Lock()
MAX_CLIPS = 3
MAX_UPLOAD = 750 * 1024**2
MAX_PROJECT = 2 * 1024**3
LONG_RENDER_RESERVE = 2 * 1024**3
CHUNK_BYTES = 2 * 1024**2
TTL = 3600
MAX_SESSION_AGE = 3 * TTL
RENDER_GATE = threading.BoundedSemaphore(value=1)

# The renderer currently has one real output geometry and one real audio
# policy. Keep the wizard contract here rather than presenting choices the
# FFmpeg pipeline cannot honour.
WIZARD_ASPECT_RATIOS = ('9:16', '16:9', '1:1')
WIZARD_AUDIO_MODES = ('selected-moment-original', 'single-source')
WIZARD_PRESETS = {
    'wizard': {},
    'cinematic': {'style': 'cinematic', 'transitions': 'dissolves'},
    'high-energy': {'style': 'hype', 'transitions': 'cuts'},
    'memory': {'style': 'memory', 'transitions': 'dissolves'},
}


def wizard_from(body, previous=None, clips=None):
    """Validate only controls the current renderer can actually apply."""
    raw = body.get('wizard', {})
    if raw is None:
        raw = {}
    if not isinstance(raw, dict):
        raise engine.TestError('Invalid Smart Edit Wizard choices.')
    preset = raw.get('preset', previous.get('preset', 'wizard') if previous else 'wizard')
    aspect = raw.get('aspectRatio', previous.get('aspectRatio', '9:16') if previous else '9:16')
    audio = raw.get('audioMode', previous.get('audioMode', 'selected-moment-original') if previous else 'selected-moment-original')
    if preset not in WIZARD_PRESETS or aspect not in WIZARD_ASPECT_RATIOS or audio not in WIZARD_AUDIO_MODES:
        raise engine.TestError('That wizard choice is not supported by this private renderer.')
    vibe = raw.get('vibePrompt', previous.get('vibePrompt', '') if previous else '')
    if not isinstance(vibe, str) or len(vibe) > 1500:
        raise engine.TestError('Keep your vibe under 1,500 characters.')
    result = dict(preset=preset, aspectRatio=aspect, audioMode=audio, vibePrompt=vibe)
    if audio == 'single-source':
        clip_id = raw.get('audioClipID', previous.get('audioClipID') if previous else None)
        start = raw.get('audioStart', previous.get('audioStart', 0) if previous else 0)
        if not isinstance(clip_id, str) or type(start) not in (int, float) or not math.isfinite(start) or start < 0:
            raise engine.TestError('Choose an audible source and start for continuous audio.')
        if clips and not any(c['id'] == clip_id and c['hasAudio'] and start < c['duration'] for c in clips):
            raise engine.TestError('Choose an uploaded source with audio for continuous audio.')
        result.update(audioClipID=clip_id, audioStart=start)
    return result


class Session:
    def __init__(self):
        self.token, self.csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        self.root = BASE / uuid.uuid4().hex
        self.root.mkdir(mode=0o700, parents=True)
        self.created = time.monotonic()
        self.last_active = self.created
        self.lock = threading.RLock()
        self.cancel = threading.Event()
        self.busy = False
        self.progress = 0
        self.status = 'Choose up to three concert clips, up to five minutes each.'
        self.status_since = self.created
        self.phase = 'choose'
        self.error = ''
        self.clips = []
        self.directed = None
        self.ready = False
        self.bytes = 0
        self.revision = 0
        self.upload = None
        self.feedback = {}
        self.receipt = None
        self.preview_revision = None
        self.split_undo = None  # One revision-bound edit snapshot, never media ownership.
        self.started = None

    def touch(self):
        self.last_active = time.monotonic()

    def state(self):
        with self.lock:
            self.touch()
            remaining = min(MAX_SESSION_AGE - (time.monotonic() - self.created),
                            TTL - (time.monotonic() - self.last_active))
            return copy.deepcopy(dict(
                version=VERSION, csrf=self.csrf, busy=self.busy,
                progress=self.progress, status=self.status, phase=self.phase,
                error=self.error, ready=self.ready, revision=self.revision,
                statusSeconds=max(0, int(time.monotonic() - self.status_since)),
                clips=[{k: c[k] for k in ('id', 'name', 'duration', 'hasAudio', 'width', 'height')} for c in self.clips],
                directed=self.directed, upload=self.upload_state(), sourceBytes=self.bytes,
                canUndoSplit=bool(self.split_undo and self.split_undo['revision'] == self.revision and not self.ready),
                feedback=self.feedback, receipt=self.receipt, previewReady=self.preview_revision == self.revision,
                expiresIn=max(0, int(remaining)),
                limits=dict(clips=MAX_CLIPS, bytesPerClip=MAX_UPLOAD, projectBytes=MAX_PROJECT,
                            secondsPerClip=engine.MAX_CLIP_SECONDS, outputBytes=engine.MAX_OUTPUT_BYTES,
                            chunkBytes=CHUNK_BYTES)))

    def upload_state(self):
        if not self.upload:
            return None
        return {k: self.upload[k] for k in ('id', 'size', 'received')}

    def work(self, fn, reserved=False):
        with self.lock:
            if self.busy and not reserved:
                raise engine.TestError('Wait for the current operation or stop it first.')
            if reserved and self.cancel.is_set():
                raise engine.TestError('Upload stopped.')
            self.busy, self.error, self.progress = True, '', 0
            if not reserved:
                self.cancel.clear()
            self.touch()
        def task():
            try:
                fn()
            except engine.TestError as e:
                with self.lock:
                    self.error = str(e)
                    self.status = 'Stopped safely. Your reviewed edit is still here.'
            except Exception:
                with self.lock:
                    self.error = 'Processing did not finish. Your originals are unchanged. Retry, or delete this test.'
            finally:
                with self.lock:
                    self.busy = False
                    self.phase = 'ready' if self.ready else 'review' if self.directed else 'choose'
                    self.touch()
        threading.Thread(target=task, daemon=True).start()

    def update(self, amount, message):
        with self.lock:
            self.progress = amount
            if message != self.status:
                self.status, self.status_since = message, time.monotonic()
            self.touch()

    def reserve_upload(self, size):
        with self.lock:
            if type(size) is not int or not 0 < size <= MAX_UPLOAD:
                raise engine.TestError('Choose a video smaller than 750 MB.')
            if self.busy or self.ready or self.upload or len(self.clips) >= MAX_CLIPS:
                raise engine.TestError('Use up to three clips. Wait for analysis or clear a finished test.')
            if self.bytes + size > MAX_PROJECT or shutil.disk_usage(BASE).free < size + LONG_RENDER_RESERVE:
                raise engine.TestError('Not enough private workspace for the source and a safe compilation render. Clear this test and use smaller clips.')
            self.busy = True
            self.cancel.clear()
            self.error = ''
            self.phase = 'upload'
            self.progress = 0
            self.status = 'Receiving your clip in small, retryable pieces'
            self.touch()
            identifier = str(uuid.uuid4()).upper()
            self.upload = dict(id=identifier, size=size, received=0, receiving=False)
            (self.root / (identifier + '.mov')).touch(mode=0o600)
            return self.upload_state()

    def discard_upload(self):
        # Caller owns lock. Never remove a file while a request is writing it.
        if self.upload and not self.upload['receiving']:
            (self.root / (self.upload['id'] + '.mov')).unlink(missing_ok=True)
            self.upload = None
            self.busy = False
            self.phase = 'review' if self.directed else 'choose'

    def analyze_upload(self):
        with self.lock:
            u = self.upload
            if not u or u['receiving'] or u['received'] != u['size']:
                raise engine.TestError('The upload is incomplete. Retry its missing pieces first.')
            path, size = self.root / (u['id'] + '.mov'), u['size']
            if self.cancel.is_set():
                self.discard_upload()
                raise engine.TestError('Upload stopped.')
            self.upload = None
            self.phase = 'analyze'
            def analyze():
                try:
                    self.update(.1, 'Checking picture and sound; preparing a compatible preview')
                    clip = engine.analyze(path, len(self.clips) + 1, self.cancel)
                    if self.cancel.is_set():
                        raise engine.TestError('Stopped safely. This clip was not added.')
                    with self.lock:
                        self.clips.append(clip)
                        self.bytes += size
                        # Adding footage must never erase a reviewed cut.  Keep its
                        # trims, locks and rejects intact; the new clip is shown as
                        # omitted until the owner explicitly replans or replaces a
                        # moment.  Re-annotate only derived coverage/review hints.
                        if self.directed:
                            self.directed = annotate(self.directed, self.clips)
                        self.revision += 1
                        self.status = ('Clip ready. Your saved edit is unchanged; the new source is not in it yet.'
                                       if self.directed else 'Clip ready. Add another or plan your reel.')
                        self.progress = 1
                except Exception:
                    for suffix in ('.mov', '.preview.mp4', '.poster.jpg'):
                        path.with_suffix(suffix).unlink(missing_ok=True)
                    raise
            self.work(analyze, reserved=True)


def reap():
    with SESSIONS_LOCK:
        for token, s in list(SESSIONS.items()):
            with s.lock:
                now = time.monotonic()
                expired = (now - s.created > MAX_SESSION_AGE
                           or (not s.busy and now - s.last_active > TTL))
                if expired:
                    s.cancel.set()
                    s.discard_upload()
                    if not s.busy:
                        shutil.rmtree(s.root, ignore_errors=True)
                        del SESSIONS[token]


def start_reaper(stop):
    while not stop.wait(20):
        reap()


def patch_plan(s, patches):
    if not s.directed:
        raise engine.TestError('Plan your reel before reviewing it.')
    updated = copy.deepcopy(s.directed['plan'])
    old = {m['id']: m for m in updated['moments']}
    if (not isinstance(patches, list) or any(not isinstance(p, dict) or not isinstance(p.get('id'), str) for p in patches)
            or len(patches) != len(old) or {p['id'] for p in patches} != set(old)):
        raise engine.TestError('The edit changed. Reload the review before rendering.')
    clips = {c['id']: c for c in s.clips}
    moments = []
    for patch in patches:
        m = old[patch['id']]
        was_locked = m['locked']
        for key in ('start', 'duration', 'approved', 'locked', 'muted', 'focusX', 'focusY', 'clipID'):
            if key in patch:
                m[key] = patch[key]
        if any(type(m[k]) is not bool for k in ('approved', 'locked', 'muted')):
            raise engine.TestError('Include, lock and mute must be true or false.')
        if any(type(m[k]) not in (int, float) or not math.isfinite(m[k]) for k in ('start', 'duration', 'focusX', 'focusY')):
            raise engine.TestError('Trim and framing values must be finite numbers.')
        clip = clips.get(m['clipID']) if isinstance(m['clipID'], str) else None
        if (not clip or m['start'] < 0 or m['duration'] < .1 or m['start'] + m['duration'] > clip['duration'] + .002
                or not 0 <= m['focusX'] <= 1 or not 0 <= m['focusY'] <= 1):
            raise engine.TestError('Keep each trim within its source and framing between 0 and 1.')
        original = next(x for x in s.directed['plan']['moments'] if x['id'] == m['id'])
        if was_locked and m['locked'] and any(m[k] != original[k] for k in ('start', 'duration', 'clipID', 'focusX', 'focusY')):
            raise engine.TestError('Unlock this moment before changing its source, trim or framing.')
        moments.append(m)
    updated['moments'] = moments
    return updated


def split_plan(s, moment_id, offset):
    """Only this operation may introduce a server-owned moment ID.

    Millisecond offsets land on the 48 kHz sample grid. Decimal subtraction
    preserves the selected endpoint (including the exact 0.1s edge case).
    Ordinary review still requires exactly the existing ID set.
    """
    if not s.directed or not s.directed['plan']['settings'].get('preserveSections'):
        raise engine.TestError('Use Keep selected sections intact before splitting a range.')
    updated = patch_plan(s, s.directed['plan']['moments'])
    if len(updated['moments']) >= engine.MAX_RENDER_MOMENTS:
        raise engine.TestError('This test supports at most 120 ranges, including rejected ranges. No split was saved.')
    if (not isinstance(moment_id, str) or type(offset) not in (int, float)
            or not math.isfinite(offset) or offset < .1 or offset > engine.MAX_CLIP_SECONDS
            or not math.isclose(offset * 1000, round(offset * 1000), rel_tol=0, abs_tol=1e-7)):
        raise engine.TestError('Choose a split in seconds from the range start, to millisecond precision, leaving at least 0.1s on each side.')
    index = next((i for i, m in enumerate(updated['moments']) if m['id'] == moment_id), None)
    if index is None:
        raise engine.TestError('That range is not in the saved edit. Reload before splitting.')
    left = updated['moments'][index]
    start, duration, point = (Decimal(str(v)) for v in (left['start'], left['duration'], offset))
    remainder = duration - point
    if remainder < Decimal('0.1'):
        raise engine.TestError('Leave at least 0.1s on each side of the split. Nothing was changed.')
    right = copy.deepcopy(left)
    right.update(id=str(uuid.uuid4()).upper(), start=float(start + point), duration=float(remainder))
    if round(offset * 48000) + round(right['duration'] * 48000) != round(left['duration'] * 48000):
        raise engine.TestError('That split cannot preserve the selected audio sample count. Choose another millisecond point.')
    left['duration'] = offset
    updated['moments'].insert(index + 1, right)
    return updated


def annotate(directed, clips):
    """Tell the owner exactly which sources the current approved edit uses."""
    used = {m['clipID'] for m in directed['plan']['moments'] if m['approved']}
    directed['coverage'] = dict(used=len(used), total=len(clips),
                               omitted=[c['name'] for c in clips if c['id'] not in used])
    directed['seconds'] = directed['timeline'][-1]['at'] + directed['timeline'][-1]['moment']['duration']
    if directed['plan']['settings'].get('preserveSections'):
        directed['seconds'] = sum(round(shot['moment']['duration'] * 48000) for shot in directed['timeline']) / 48000
    # This is intentionally a review-only recommendation.  It gives the
    # client a measurable alternate story order without silently moving a
    # reviewed trim, rejection, lock, mute choice, or manual framing.
    directed['editorialProposal'] = (None if directed['plan']['settings'].get('preserveSections') else
        propose_editorial_refinement(directed['plan'], clips).as_dict())
    return directed


def require_render_workspace(session, settings, wizard=None, duration=0):
    """Reserve room for bounded segment/piece files before a heavy render."""
    profile = engine.output_profile(engine.render_target(settings, duration), (wizard or {}).get('aspectRatio', '9:16'))
    reserve = LONG_RENDER_RESERVE if profile['width'] == 720 else 1024**3
    if shutil.disk_usage(session.root).free < reserve:
        raise engine.TestError('Not enough free private workspace for this render. Clear another test or choose a shorter compilation.')
    return profile


def require_compilation_approval(settings, approved):
    if settings['targetSeconds'] > 60 and approved is not True:
        raise engine.TestError('Confirm the longer 720p compilation before planning it.')


def require_directed_compilation_approval(directed, approved):
    require_compilation_approval(directed['plan']['settings'], approved)
    if directed['plan']['settings'].get('preserveSections'):
        actual = sum(shot['moment']['duration'] for shot in directed['timeline'])
        if actual > 60 and approved is not True:
            raise engine.TestError(f'Your intact sections total {actual:.1f}s. Confirm the longer 720p compilation, or remove/unlock and trim a section.')


class Handler(BaseHTTPRequestHandler):
    server_version = 'CompassQualityTest'
    def log_message(self, *args):
        pass  # Do not log media, tokens, prompts or access paths.

    def _headers(self, status, kind='application/json', length=0, extra=None):
        self.send_response(status)
        headers = {
            'Content-Type': kind, 'Content-Length': str(length), 'Cache-Control': 'no-store',
            'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
            'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
            'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self' blob:; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
            'Connection': 'close', **(extra or {})}
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()
        self.close_connection = True

    def send_json(self, data, status=200, extra=None):
        b = json.dumps(data, allow_nan=False).encode()
        self._headers(status, length=len(b), extra=extra)
        if self.command != 'HEAD':
            self.wfile.write(b)

    def session(self):
        cookie = http.cookies.SimpleCookie()
        try:
            cookie.load(self.headers.get('Cookie', ''))
        except http.cookies.CookieError:
            pass
        token = cookie['compass'].value if 'compass' in cookie else ''
        with SESSIONS_LOCK:
            s = SESSIONS.get(token)
        now = time.monotonic()
        if not s or now - s.created >= MAX_SESSION_AGE:
            return None
        with s.lock:
            if not s.busy and now - s.last_active >= TTL:
                return None
            s.touch()
        return s

    def guard(self, write=False):
        origin = self.headers.get('Origin')
        name = os.environ.get('CODESPACE_NAME')
        domain = os.environ.get('GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN', 'app.github.dev').lower()
        host = self.headers.get('Host', '').lower()
        allowed = {f'http://127.0.0.1:{self.server.server_port}', f'http://localhost:{self.server.server_port}',
                   f'https://localhost:{self.server.server_port}'}
        if name:
            allowed.add(f'https://{name.lower()}-{PORT}.{domain}')
        trusted_hosts = {urlsplit(x).netloc for x in allowed}
        landing = self.command in ('GET', 'HEAD') and urlsplit(self.path).path == '/' and self.headers.get('Sec-Fetch-Mode') == 'navigate'
        if ((origin is not None and origin.lower() not in allowed)
                or (origin is None and self.headers.get('Sec-Fetch-Site') == 'cross-site' and not landing)):
            self.send_json({'error': 'Cross-site requests are blocked.'}, 403)
            return False
        if host not in trusted_hosts:
            self.send_json({'error': 'Unrecognized test host.'}, 403)
            return False
            return False
        if write:
            s = self.session()
            if not s or not secrets.compare_digest(self.headers.get('X-Compass-CSRF', ''), s.csrf):
                self.send_json({'error': 'Session expired. Reload the private test page.'}, 403)
                return False
        return True

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        try:
            if not self.guard():
                return
            path = urlsplit(self.path).path
            static = {'/': ('index.html', 'text/html; charset=utf-8'),
                      '/app.js': ('app.js', 'text/javascript'), '/style.css': ('style.css', 'text/css')}
            if path in static:
                file, kind = static[path]
                b = (engine.HERE / 'static' / file).read_bytes()
                self._headers(200, kind, len(b))
                if self.command != 'HEAD':
                    self.wfile.write(b)
                return
            if path == '/api/health':
                self.send_json(dict(version=VERSION, planner=engine.CLI.is_file(),
                                    mode='private-development-test', nativeApp=False,
                                    billingVerified=False, deviceTested=False))
                return
            if path == '/api/state':
                reap()
                s = self.session()
                extra = {}
                if not s:
                    with SESSIONS_LOCK:
                        if len(SESSIONS) >= 2:
                            self.send_json({'error': 'Two test sessions already exist. Return to your original tab.'}, 429)
                            return
                        s = Session()
                        SESSIONS[s.token] = s
                    secure = '; Secure' if os.environ.get('CODESPACE_NAME') else ''
                    extra = {'Set-Cookie': f'compass={s.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={MAX_SESSION_AGE}{secure}'}
                self.send_json(s.state(), extra=extra)
                return
            s = self.session()
            if not s:
                self.send_json({'error': 'Open your private test session first.'}, 401)
                return
            if path == '/api/preview' and s.preview_revision == s.revision:
                requested = parse_qs(urlsplit(self.path).query).get('revision')
                if requested is not None and (len(requested) != 1 or not requested[0].isdigit()
                                              or int(requested[0]) != s.preview_revision):
                    self.send_json({'error': 'That preview is no longer current. Refresh the review.'}, 409)
                    return
                self.media(s.root / 'preview.mp4')
                return
            if path in ('/api/reel', '/api/download') and s.ready:
                self.media(s.root / 'reel.mp4', download=path == '/api/download')
                return
            if path == '/api/report':
                self.send_json(dict(version=VERSION, mode='Linux quality test, not native iPhone validation',
                                    receipt=s.receipt, userReported=s.feedback,
                                    sourceCopiesDeleted=s.ready, codespaceDeleted='not verifiable from this app'),
                               extra={'Content-Disposition': 'attachment; filename="Concert-Compass-Test-Receipt.json"'})
                return
            if not s.ready and (path.startswith('/api/clip/') or path.startswith('/api/poster/')):
                clip = next((c for c in s.clips if c['id'] == path.rsplit('/', 1)[-1]), None)
                if clip:
                    poster = path.startswith('/api/poster/')
                    suffix = '.poster.jpg' if poster else '.preview.mp4'
                    self.media((s.root / clip['fileName']).with_suffix(suffix), kind='image/jpeg' if poster else 'video/mp4')
                    return
            self.send_json({'error': 'Not found.'}, 404)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except FileNotFoundError:
            self.send_json({'error': 'This test media was deleted or expired.'}, 410)

    def media(self, path, download=False, kind='video/mp4'):
        if not path.is_file():
            self.send_json({'error': 'Test media expired or was deleted.'}, 410)
            return
        # Open before sending headers so concurrent cleanup is harmless on Linux.
        with path.open('rb') as f:
            size = os.fstat(f.fileno()).st_size
            start, end, status = 0, size - 1, 200
            request_range = self.headers.get('Range')
            if request_range:
                m = re.fullmatch(r'bytes=(\d*)-(\d*)', request_range)
                if not m or not any(m.groups()):
                    self._headers(416, extra={'Content-Range': f'bytes */{size}'})
                    return
                if m[1]:
                    start = int(m[1]); end = min(size - 1, int(m[2])) if m[2] else size - 1
                else:
                    start = max(0, size - int(m[2]))
                if start > end or start >= size:
                    self._headers(416, extra={'Content-Range': f'bytes */{size}'})
                    return
                status = 206
            extra = {'Accept-Ranges': 'bytes',
                     'Content-Disposition': ('attachment' if download else 'inline') + '; filename="Concert-Compass-Test.mp4"'}
            if kind != 'video/mp4':
                extra.pop('Content-Disposition')
            if status == 206:
                extra['Content-Range'] = f'bytes {start}-{end}/{size}'
            self._headers(status, kind, end - start + 1, extra)
            if self.command == 'HEAD':
                return
            f.seek(start)
            left = end - start + 1
            while left:
                b = f.read(min(left, 65536))
                if not b:
                    break
                self.wfile.write(b); left -= len(b)

    def read_json(self):
        n = int(self.headers.get('Content-Length', '0'))
        if self.headers.get('Transfer-Encoding') or n <= 0 or n > 65536:
            raise engine.TestError('Invalid request size.')
        if self.headers.get_content_type() != 'application/json':
            raise engine.TestError('Expected a JSON request.')
        self.connection.settimeout(30)
        def invalid_constant(_):
            raise engine.TestError('Non-finite numbers are not accepted.')
        data = json.loads(self.rfile.read(n), parse_constant=invalid_constant)
        if not isinstance(data, dict):
            raise engine.TestError('Expected a settings object.')
        return data

    def do_POST(self):
        try:
            if not self.guard(write=True):
                return
            s, path = self.session(), urlsplit(self.path).path
            if not s:
                raise engine.TestError('Session expired.')
            if path == '/api/cancel':
                with s.lock:
                    s.cancel.set(); s.discard_upload()
                    s.status = 'Stopped. Completed uploads and saved edits are still here.'
                self.send_json({'ok': True})
                return
            if path == '/api/clear':
                with s.lock:
                    if s.busy:
                        raise engine.TestError('Stop the running task before deleting its files.')
                    shutil.rmtree(s.root, ignore_errors=True); s.root.mkdir(mode=0o700)
                    s.clips, s.directed, s.ready, s.bytes = [], None, False, 0
                    s.upload, s.receipt, s.feedback, s.preview_revision = None, None, {}, None
                    s.split_undo = None
                    s.revision += 1; s.phase = 'choose'; s.error = ''; s.progress = 0
                    s.status = 'All test media deleted. Delete the Codespace too when finished.'
                self.send_json({'ok': True})
                return
            if path == '/api/uploads':
                body = self.read_json()
                u = s.reserve_upload(body.get('size'))
                self.send_json({**u, 'chunkBytes': CHUNK_BYTES}, 201)
                return
            if path == '/api/uploads/finish':
                body = self.read_json()
                with s.lock:
                    if not s.upload or s.upload['id'] != body.get('id'):
                        raise engine.TestError('That upload is no longer active.')
                    s.analyze_upload()
                self.send_json({'ok': True}, 202)
                return
            if path in ('/api/split', '/api/split/undo'):
                body = self.read_json()
                with s.lock:
                    if s.busy or s.ready or not s.directed:
                        raise engine.TestError('Finish the current operation and open a saved edit before splitting or undoing.')
                    revision = body.get('revision')  # Required, never default to the latest revision.
                    if type(revision) is not int or revision != s.revision:
                        self.send_json({'error': 'A newer edit exists or the split revision is missing. Reload before changing it.'}, 409)
                        return
                    undoing = path == '/api/split/undo'
                    before = copy.deepcopy(s.directed)
                    if undoing:
                        if not s.split_undo or s.split_undo['revision'] != revision:
                            raise engine.TestError('Undo is available only for the last split, before another edit is saved.')
                        updated = copy.deepcopy(s.split_undo['directed']['plan'])
                    else:
                        updated = split_plan(s, body.get('momentID'), body.get('offset'))
                    def split_operation():
                        checked = annotate(engine.direct(s.root, s.clips, updated['settings'], s.cancel, plan=updated), s.clips)
                        checked['wizard'] = copy.deepcopy(before.get('wizard', {}))
                        with s.lock:
                            if s.cancel.is_set():
                                raise engine.TestError('Split operation stopped before saving. Your prior edit is unchanged.')
                            if s.revision != revision:
                                raise engine.TestError('The edit changed before the split could be saved.')
                            s.directed = checked
                            s.revision += 1
                            s.preview_revision = None
                            s.split_undo = None if undoing else dict(revision=s.revision, directed=before)
                            s.update(1, 'Split undone. Update preview before export.' if undoing else
                                     'Range split saved in order. Both halves keep approval, lock, mute and framing. Update preview before export.')
                    s.phase = 'review'
                    s.work(split_operation)
                self.send_json({'ok': True}, 202)
                return
            if path in ('/api/plan', '/api/review', '/api/render'):
                body = self.read_json()
                with s.lock:
                    if s.busy:
                        raise engine.TestError('Wait for the current operation or stop it first.')
                    if not s.clips or s.ready:
                        raise engine.TestError('Choose clips first. Clear a finished test to begin another.')
                    revision = body.get('revision', s.revision)
                    if type(revision) is not int or revision != s.revision:
                        self.send_json({'error': 'A newer edit exists in another tab. Reload before changing it.'}, 409)
                        return
                    if path == '/api/plan':
                        previous_wizard = s.directed.get('wizard') if s.directed else None
                        wizard = wizard_from(body, previous_wizard, s.clips)
                        # A post-preview adjustment is the newest instruction. It
                        # is deliberately sent through the same local planner as
                        # the first cut, so it changes the saved timeline rather
                        # than becoming a suggestion-only note.
                        adjustment = body.get('editRequest')
                        if adjustment is not None:
                            if not isinstance(adjustment, str) or not adjustment.strip() or len(adjustment) > 1500:
                                raise engine.TestError('Describe one supported adjustment in under 1,500 characters.')
                            if not s.directed:
                                raise engine.TestError('Make a first cut before asking for an adjustment.')
                            requested = copy.deepcopy(s.directed['plan']['settings'])
                            requested['prompt'] = adjustment
                            if 'preserveSections' in body:
                                requested['preserveSections'] = body['preserveSections']
                            wizard['vibePrompt'] = adjustment
                            settings = engine.settings_from(requested)
                        else:
                            settings = engine.settings_from(body)
                        explicit = body.get('explicitSettings', []) if adjustment is None else []
                        allowed_explicit = {'mode', 'style', 'targetSeconds', 'transitions', 'gentleCleanup', 'preserveSections'}
                        if not isinstance(explicit, list) or any(x not in allowed_explicit for x in explicit):
                            raise engine.TestError('Invalid explicit wizard setting.')
                        require_compilation_approval(settings, body.get('compilationApproved'))
                        previous = patch_plan(s, body['previousMoments']) if s.directed and body.get('previousMoments') is not None else (s.directed['plan'] if s.directed else None)
                        def operation():
                            if previous and any(m['approved'] for m in previous['moments']):
                                engine.direct(s.root, s.clips, previous['settings'], s.cancel, plan=previous)
                            result = engine.direct(s.root, s.clips, settings, s.cancel, previous=previous, seed=s.revision,
                                                   explicit_settings=explicit)
                            # The bounded prompt interpreter can request a longer target.
                            # Recheck its visible result so wording cannot bypass the UI's
                            # explicit long-compilation confirmation.
                            require_directed_compilation_approval(result, body.get('compilationApproved'))
                            # The renderer validates the frame-aligned interval
                            # against actual audio, not video duration, before
                            # rendering any pictures (including older sessions).
                            with s.lock:
                                s.directed = annotate(result, s.clips)
                                s.directed['wizard'] = wizard
                                s.revision += 1
                                s.preview_revision = None
                            profile = require_render_workspace(s, result['plan']['settings'], wizard, s.directed['seconds'])
                            engine.render(s.root, s.clips, s.directed, s.cancel, s.update, preview=True)
                            with s.lock:
                                s.preview_revision = s.revision
                                s.status = ('Adjusted first cut ready. Review the actual changed moments before rendering.'
                                            if adjustment is not None else 'Review your moments. Nothing is rendered until you approve.')
                        s.phase = 'plan'
                    else:
                        updated = patch_plan(s, body.get('moments'))
                        if path == '/api/render' and body.get('reviewed') is not True:
                            raise engine.TestError('Review and approve your moments first.')
                        rendering = path == '/api/render'
                        if rendering:
                            saved = s.directed['plan']
                            if updated != saved:
                                raise engine.TestError('Your submitted edits differ from the reviewed preview. Update preview before export; uploaded sources were kept.')
                            for key in ('mode', 'style', 'targetSeconds', 'transitions', 'gentleCleanup', 'preserveSections', 'prompt'):
                                if key in body and body[key] != saved['settings'].get(key, False if key == 'preserveSections' else None):
                                    raise engine.TestError('Your submitted settings differ from the reviewed preview. Update preview before export; uploaded sources were kept.')
                            if 'wizard' in body and wizard_from(body, s.directed.get('wizard'), s.clips) != s.directed.get('wizard', {}):
                                raise engine.TestError('Your submitted output settings differ from the reviewed preview. Update preview before export; uploaded sources were kept.')
                            if s.preview_revision != s.revision:
                                raise engine.TestError('Your edit changed. Update preview before export; uploaded sources were kept.')
                        refresh_preview = body.get('preview') is True
                        if 'preview' in body and type(body['preview']) is not bool:
                            raise engine.TestError('Preview update must be true or false.')
                        def operation():
                            checked = annotate(engine.direct(s.root, s.clips, updated['settings'], s.cancel, plan=updated), s.clips)
                            # Review/render validation recreates a response from
                            # Swift; carry the persisted wizard contract forward.
                            checked['wizard'] = copy.deepcopy(s.directed.get('wizard', {}))
                            if not rendering and refresh_preview and checked['plan']['settings'].get('preserveSections'):
                                require_directed_compilation_approval(checked, body.get('compilationApproved'))
                            # Saving edits invalidates the assembled preview; export
                            # may only promote the still-current reviewed preview.
                            if not rendering:
                                with s.lock:
                                    s.directed = checked; s.revision += 1
                                    s.preview_revision = None
                            if not rendering:
                                if refresh_preview:
                                    profile = require_render_workspace(s, checked['plan']['settings'], checked.get('wizard'), checked['seconds'])
                                    engine.render(s.root, s.clips, s.directed, s.cancel, s.update, preview=True)
                                    with s.lock:
                                        s.preview_revision = s.revision
                                        s.status = 'Updated preview ready. Review this exact revision before export.'
                                    return
                                s.update(1, 'Edits saved in this session. Refreshing the page keeps them.')
                                return
                            if not RENDER_GATE.acquire(blocking=False):
                                raise engine.TestError('Another private compilation is rendering. Wait for it to finish, then render this reviewed edit again.')
                            try:
                                profile = require_render_workspace(s, checked['plan']['settings'], checked.get('wizard'), checked['seconds'])
                                before = time.monotonic()
                                result = engine.finalize_preview(s.root)
                                with s.lock:
                                    s.ready, s.bytes = True, 0
                                    s.receipt = dict(codec='H.264 / AAC', width=profile['width'], height=profile['height'],
                                        profile=profile['name'], seconds=round(checked['seconds'], 3), bytes=result.stat().st_size,
                                        moments=len(checked['timeline']), coverage=checked['coverage'],
                                        audioTransition=engine.intact_audio_transition(checked),
                                        renderSeconds=round(time.monotonic()-before, 2),
                                        completeDecode=True, sourceCopiesDeleted=True,
                                        nativeTest=False, physicalPhoneTest='unverified')
                            finally:
                                RENDER_GATE.release()
                        s.phase = 'render' if rendering else 'review'
                    s.work(operation)
                self.send_json({'ok': True}, 202)
                return
            if path == '/api/feedback':
                body = self.read_json()
                if not s.ready:
                    raise engine.TestError('Review a complete rendered reel before recording feedback.')
                allowed = ('completePlayback', 'soundInSync', 'savedToPhotos', 'photosSound', 'capturesNight', 'wouldShare')
                if any(k not in allowed or type(v) is not bool for k, v in body.items()):
                    raise engine.TestError('Feedback must contain supported yes/no answers.')
                with s.lock:
                    s.feedback.update(body)
                self.send_json({'ok': True})
                return
            self.send_json({'error': 'Not found.'}, 404)
        except (engine.TestError, ValueError, TypeError, KeyError, OSError):
            import sys
            e = sys.exc_info()[1]
            message = str(e)[:700] if isinstance(e, engine.TestError) else 'Invalid request. Reload the review and try again.'
            try:
                self.send_json({'error': message}, 400)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def do_PUT(self):
        s, upload_id, receiving = None, None, False
        try:
            if not self.guard(write=True):
                return
            s, path = self.session(), urlsplit(self.path).path
            if not s:
                raise engine.TestError('Session expired.')
            n = int(self.headers.get('Content-Length', '0'))
            if self.headers.get('Transfer-Encoding') or not 0 < n <= MAX_UPLOAD:
                raise engine.TestError('Choose a video smaller than 750 MB.')
            legacy = path == '/api/upload'
            if not legacy and not path.startswith('/api/upload-chunk/'):
                self.send_json({'error': 'Not found.'}, 404)
                return
            if not legacy and n > CHUNK_BYTES:
                raise engine.TestError('Upload pieces must be no larger than 2 MB.')
            if legacy:
                s.reserve_upload(n)
            with s.lock:
                u = s.upload
                upload_id = u['id'] if legacy and u else path.rsplit('/', 1)[-1]
                if not u or u['id'] != upload_id or u['receiving'] or s.cancel.is_set():
                    raise engine.TestError('This upload is not available. Stop and retry the clip.')
                offset = 0 if legacy else int(self.headers.get('X-Upload-Offset', '-1'))
                if offset < 0 or offset > u['received'] or offset + n > u['size']:
                    raise engine.TestError('Upload offset mismatch. Retry from the confirmed position.')
                if offset < u['received'] and offset + n > u['received']:
                    raise engine.TestError('Partial overlap is not a valid retry.')
                u['receiving'] = True; receiving = True
            self.connection.settimeout(45)
            target = s.root / (upload_id + '.mov')
            if legacy:
                with target.open('wb') as f:
                    remaining = n
                    while remaining:
                        if s.cancel.is_set():
                            raise engine.TestError('Upload stopped.')
                        b = self.rfile.read(min(65536, remaining))
                        if not b:
                            raise engine.TestError('Upload interrupted. Retry this clip.')
                        f.write(b); remaining -= len(b)
            else:
                # Buffer a bounded chunk before touching disk, so a broken connection
                # cannot leave a half-committed offset. Exact retries are idempotent.
                data = self.rfile.read(n)
                if len(data) != n:
                    raise engine.TestError('Upload piece interrupted. Retry this piece.')
                with s.lock:
                    if s.cancel.is_set():
                        raise engine.TestError('Upload stopped.')
                    with target.open('r+b') as f:
                        f.seek(offset)
                        if offset < u['received']:
                            if not secrets.compare_digest(hashlib.sha256(f.read(n)).digest(), hashlib.sha256(data).digest()):
                                raise engine.TestError('A retried piece did not match the original. Stop and reselect the clip.')
                        else:
                            f.write(data)
            with s.lock:
                u['received'] = max(u['received'], offset+n)
                u['receiving'] = False; receiving = False
                s.progress = u['received'] / u['size']
                if s.cancel.is_set():
                    s.discard_upload()
                    raise engine.TestError('Upload stopped.')
                if legacy:
                    s.analyze_upload()
                    response = {'ok': True}
                else:
                    response = s.upload_state()
            self.send_json(response, 202 if legacy else 200)
        except (engine.TestError, ValueError, OSError) as e:
            if s and upload_id:
                with s.lock:
                    if s.upload and s.upload['id'] == upload_id:
                        if receiving:
                            s.upload['receiving'] = False
                        if s.cancel.is_set() or urlsplit(self.path).path == '/api/upload':
                            s.discard_upload()
            try:
                self.send_json({'error': str(e)[:500] if isinstance(e, engine.TestError) else 'The upload connection failed. Retry this piece.'}, 400)
            except (BrokenPipeError, ConnectionResetError):
                pass


def main():
    import fcntl
    BASE.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = (BASE / 'server.lock').open('w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        raise SystemExit('The private test is already running.')
    for p in BASE.iterdir():
        if p.is_dir():
            shutil.rmtree(p)
    if not engine.CLI.is_file():
        raise SystemExit('Build the QualityCLI before starting.')
    stop = threading.Event()
    threading.Thread(target=start_reaper, args=(stop,), daemon=True).start()
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    server.daemon_threads = True
    print(f'Private development test ready: http://localhost:{PORT}', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop.set(); server.server_close()
        with SESSIONS_LOCK:
            for s in SESSIONS.values():
                s.cancel.set()
                if not s.busy:
                    shutil.rmtree(s.root, ignore_errors=True)


if __name__ == '__main__':
    main()
