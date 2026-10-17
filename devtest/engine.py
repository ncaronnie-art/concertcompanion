"""Private development renderer. Reuses CompassCore; never invokes a remote model."""
from __future__ import annotations
import array, json, math, os, signal, subprocess, sys, time, uuid
from pathlib import Path
from threading import Event

HERE = Path(__file__).resolve().parent
CLI = HERE / '.build/release/QualityCLI'
MAX_CLIP_SECONDS = 30.0

class TestError(Exception):
    pass


def run(args: list[str], cancel: Event | None = None, timeout: int = 180) -> bytes:
    # Child processes get no GitHub tokens, cloud credentials, or request data in env.
    env = {k: os.environ[k] for k in ('PATH', 'HOME', 'LANG', 'LD_LIBRARY_PATH') if k in os.environ}
    p = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                         env=env, start_new_session=True)
    deadline = time.monotonic() + timeout
    try:
        while True:
            if cancel and cancel.is_set():
                raise TestError('Stopped safely. No partial reel is shareable.')
            if time.monotonic() > deadline:
                raise TestError('This operation took too long. Try shorter clips.')
            try:
                out, err = p.communicate(timeout=0.2)
                break
            except subprocess.TimeoutExpired:
                continue
        if p.returncode:
            if Path(args[0]).name == 'QualityCLI':
                raise TestError(err.decode(errors='replace')[:700].strip())
            failure = TestError('Media processing failed. Try a shorter standard MOV or MP4 clip; your originals are unchanged.')
            failure.diagnostic = err.decode(errors='replace')[-4000:]
            raise failure
        return out
    finally:
        if p.poll() is None:
            os.killpg(p.pid, signal.SIGKILL)
            p.communicate()


def ff(args, cancel=None, timeout=180):
    return run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
                '-threads', '2', '-filter_threads', '1', '-filter_complex_threads', '1'] + args, cancel, timeout)


def inp(path: Path):
    return ['-protocol_whitelist', 'file,pipe', '-i', str(path)]


def probe(path: Path, cancel=None):
    return json.loads(run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe',
                          '-show_streams', '-show_format', '-of', 'json', str(path)], cancel, 30))


def color_filter(video):
    if video.get('color_transfer') in ('smpte2084', 'arib-std-b67'):
        return 'zscale=t=linear:npl=100,format=gbrpf32le,tonemap=tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv,'
    return ''


def analyze(path: Path, number: int, cancel: Event):
    info = probe(path, cancel)
    videos = [s for s in info['streams'] if s['codec_type'] == 'video' and not s.get('disposition', {}).get('attached_pic')]
    if not videos or not {'mov', 'mp4', 'm4v'}.intersection(info.get('format', {}).get('format_name', '').split(',')):
        raise TestError('Choose a camera MOV or MP4 video, not a playlist or another file type.')
    video = videos[0]
    duration = float(video.get('duration') or info['format'].get('duration', 0))
    width, height = int(video['width']), int(video['height'])
    if not math.isfinite(duration) or not 0.15 <= duration <= MAX_CLIP_SECONDS + 0.04:
        raise TestError('For this first test, each clip must be between 0.15 and 30 seconds.')
    if width <= 0 or height <= 0 or max(width, height) > 8192:
        raise TestError('This test supports camera video up to 8K dimensions.')
    rotation = next((float(s.get('rotation', 0)) for s in video.get('side_data_list', []) if 'rotation' in s), 0)
    if round(rotation) % 180 != 0:
        width, height = height, width
    has_audio = any(s['codec_type'] == 'audio' for s in info['streams'])
    audio = []
    if has_audio:
        raw = ff(inp(path) + ['-t', str(duration), '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'], cancel)
        samples = array.array('f'); samples.frombytes(raw)
        if sys.byteorder != 'little': samples.byteswap()
        bins = [samples[i:i + 1600] for i in range(0, len(samples), 1600)]
        rms = [math.sqrt(sum(x*x for x in b if math.isfinite(x)) / max(1, len(b))) for b in bins]
        high = max(.001, sorted(rms)[min(len(rms)-1, math.ceil((len(rms)-1)*.95))]) if rms else .001
        last = 0
        for i, value in enumerate(rms):
            energy = min(1, value/high)
            audio.append(dict(time=i*.1, energy=energy, onset=0 if i == 0 else min(1, max(0, energy-last)*3),
                              clipping=sum(abs(x)>.985 for x in bins[i])/max(1, len(bins[i]))))
            last = energy
    raw = ff(inp(path) + ['-t', str(duration), '-vf', color_filter(video)+'fps=1,scale=64:64,format=gray',
                         '-an', '-f', 'rawvideo', 'pipe:1'], cancel)
    visual, previous = [], None
    for i in range(0, len(raw)-4095, 4096):
        pixels = raw[i:i+4096]
        lap = [(pixels[p-1]+pixels[p+1]+pixels[p-64]+pixels[p+64]-4*pixels[p])**2
               for y in range(1, 63, 2) for x in range(1, 63, 2) for p in [y*64+x]]
        difference = sum(abs(a-b) for a,b in zip(previous,pixels))/4096/64 if previous else .2
        visual.append(dict(time=i/4096, brightness=sum(pixels)/4096/255,
                           sharpness=min(1, math.log1p(sum(lap)/len(lap))/9), shake=min(1, difference)))
        previous = pixels
    clip = dict(id=path.stem.upper(), name=f'Clip {number}', fileName=path.name, duration=duration,
                width=width, height=height, hasAudio=has_audio, mediaStart=0,
                audio=audio, visual=visual, warnings=['Linux image difference is a motion proxy, not camera-shake recognition.'])
    proxy = path.with_suffix('.preview.mp4')
    ff(inp(path) + ['-t', str(duration), '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', color_filter(video)+'scale=540:960:force_original_aspect_ratio=decrease,pad=540:960:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30,format=yuv420p',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-threads', '2', '-c:a', 'aac', '-ar', '48000', '-ac', '2',
        '-map_metadata', '-1', '-movflags', '+faststart', str(proxy)], cancel)
    return clip


def settings_from(data):
    result = dict(mode='highlight', style='memory', targetSeconds=15, transitions='automatic',
                  gentleCleanup=False, stabilize=False, prompt='')
    for key in result:
        if key in data: result[key] = data[key]
    if not isinstance(result['prompt'], str) or len(result['prompt']) > 1500:
        raise TestError('Keep your direction under 1,500 characters.')
    if result['gentleCleanup'] not in (True, False) or result['stabilize'] is not False:
        raise TestError('Unsupported cleanup or stabilization setting.')
    return result


def direct(root, clips, settings, cancel, plan=None, previous=None):
    request = dict(clips=clips, settings=settings, action='validate' if plan is not None else 'plan', plan=plan, previous=previous)
    source, target = root/'request.json', root/'response.json'
    source.write_text(json.dumps(request, allow_nan=False))
    try:
        run([str(CLI), str(source), str(target)], cancel, 30)
        return json.loads(target.read_text())
    finally:
        source.unlink(missing_ok=True); target.unlink(missing_ok=True)


def render(root, clips, directed, cancel, progress):
    shots = directed['timeline']
    if len(shots) > 40: raise TestError('This first test supports up to 40 moments.')
    by_id = {c['id']: c for c in clips}
    segments = []
    duration = shots[-1]['at'] + shots[-1]['moment']['duration']
    settings = directed['plan']['settings']
    for i, shot in enumerate(shots):
        moment = shot['moment']; clip = by_id[moment['clipID']]
        source = root / clip['fileName']
        length = moment['duration']
        video = next(s for s in probe(source, cancel)['streams'] if s['codec_type'] == 'video')
        target = root / f'segment-{i}.mp4'
        args = ['-ss', str(moment['start'])] + inp(source)
        audible = clip['hasAudio'] and not moment['muted']
        if not audible: args += ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']
        vf = color_filter(video)+f'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920:(iw-ow)*{moment["focusX"]}:(ih-oh)*{moment["focusY"]},setsar=1,fps=30,format=yuv420p'
        af = 'aresample=48000:async=1:first_pts=0,apad'
        if settings['gentleCleanup']: af += ',highpass=f=70:mix=0.45'
        args += ['-map','0:v:0','-map','0:a:0' if audible else '1:a:0', '-t',str(length), '-vf',vf, '-af',af,
                 '-c:v','libx264','-preset','veryfast','-crf','20','-threads','2','-x264-params','colorprim=bt709:transfer=bt709:colormatrix=bt709',
                 '-c:a','aac','-b:a','192k','-ar','48000','-ac','2','-map_metadata','-1',
                 '-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-movflags','+faststart',str(target)]
        ff(args,cancel); segments.append(target); progress((i+1)/len(shots)*.65, 'Rendering selected moments')
    args, graph = [], []
    for i, source in enumerate(segments):
        args += inp(source)
        graph += [f'[{i}:v]setpts=PTS-STARTPTS,fps=30,settb=AVTB[v{i}]', f'[{i}:a]asetpts=PTS-STARTPTS[a{i}]']
    v,a = 'v0','a0'
    for i, shot in enumerate(shots[1:],1):
        nv,na = f'mv{i}',f'ma{i}'
        if shot['incoming']=='dissolve' and shot['overlap']>0:
            graph += [f'[{v}][v{i}]xfade=transition=fade:duration={shot["overlap"]}:offset={shot["at"]}[pre{nv}]', f'[pre{nv}]fps=30,settb=AVTB[{nv}]',
                      f'[{a}][a{i}]acrossfade=d={shot["overlap"]}:c1=tri:c2=tri[{na}]']
        else:
            graph += [f'[{v}][v{i}]concat=n=2:v=1:a=0[pre{nv}]', f'[pre{nv}]fps=30,settb=AVTB[{nv}]', f'[{a}][a{i}]concat=n=2:v=0:a=1[{na}]']
        v,a=nv,na
    graph += [f'[{v}]fps=30,format=yuv420p,setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709[video]', f'[{a}]apad[audio]']
    pending = root/'pending.mp4'
    progress(.7, 'Assembling the complete reel')
    ff(args+['-filter_complex',';'.join(graph),'-map','[video]','-map','[audio]','-t',str(duration),
             '-c:v','libx264','-preset','veryfast','-crf','20','-threads','2','-x264-params','colorprim=bt709:transfer=bt709:colormatrix=bt709','-c:a','aac','-b:a','192k','-ar','48000',
             '-map_metadata','-1','-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709','-movflags','+faststart',str(pending)],cancel,360)
    verify(pending,duration,cancel)
    final=root/'reel.mp4'; pending.replace(final)
    # Once the completed reel exists, source copies/proxies/intermediates are unnecessary.
    for p in root.iterdir():
        if p.is_file() and p != final: p.unlink()
    progress(1, 'Full reel ready. Source copies have been deleted.')
    return final


def verify(path, expected, cancel):
    info=probe(path,cancel)
    v=next((s for s in info['streams'] if s['codec_type']=='video'),{})
    a=next((s for s in info['streams'] if s['codec_type']=='audio'),{})
    if (v.get('codec_name'),v.get('width'),v.get('height'),a.get('codec_name')) != ('h264',1080,1920,'aac'):
        raise TestError('Output codec or dimensions failed validation. No reel was published.')
    if abs(float(info['format']['duration'])-expected)>.16:
        raise TestError('The full duration failed verification. No partial reel was published.')
    for t in (0,expected/2,max(0,expected-.15)):
        frame=ff(['-ss',str(t)]+inp(path)+['-frames:v','1','-vf','scale=32:32','-an','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],cancel)
        if len(frame)!=3072: raise TestError('A first, middle or final frame failed to decode.')
