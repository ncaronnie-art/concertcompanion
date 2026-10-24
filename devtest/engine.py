"""Private development renderer. Reuses CompassCore; never invokes a remote model."""
from __future__ import annotations
import array, copy, json, math, os, signal, subprocess, sys, time, uuid
from pathlib import Path
from threading import Event
from fractions import Fraction
from audio.policy import AudioPolicy

HERE = Path(__file__).resolve().parent
CLI = HERE / '.build/release/QualityCLI'
# Desktop-first intake: enough source duration to preserve a complete song
# section without asking the owner to pre-trim on their phone. The desktop
# shell can also make a deliberately selected five-minute compilation.
MAX_CLIP_SECONDS = 300.0
SUPPORTED_TARGET_SECONDS = (15, 30, 45, 60, 90, 120, 180, 300)
MAX_RENDER_MOMENTS = 120
MAX_OUTPUT_BYTES = 350 * 1024**2

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
    return ['-protocol_whitelist', 'file,pipe', '-threads', '2', '-i', str(path)]


def probe(path: Path, cancel=None):
    return json.loads(run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe',
                          '-show_streams', '-show_format', '-of', 'json', str(path)], cancel, 30))


def stream_seconds(stream, key):
    """Read a finite stream timestamp, preferring its unrounded time base."""
    ticks_key = 'start_pts' if key == 'start_time' else 'duration_ts'
    try:
        value = float(int(stream[ticks_key]) * Fraction(stream['time_base']))
    except (KeyError, TypeError, ValueError, ZeroDivisionError):
        try:
            value = float(stream[key])
        except (KeyError, TypeError, ValueError):
            return None
    return value if math.isfinite(value) else None


def ff_time(seconds):
    # FFmpeg's duration parser does not accept Python's scientific notation.
    # Nanosecond precision is well below one audio sample, including offsets
    # caused by the format's six-decimal timestamp rounding.
    return f'{seconds:.9f}'


def source_timing(info):
    """Clip times are relative to the first video timestamp, not each stream.

    FFmpeg's input -ss is relative to format.start_time. Audio may begin before
    or after video; subtracting its own STARTPTS would move the performance.
    An unknown audio extent is not evidence of continuous soundtrack coverage.
    """
    video = next(s for s in info['streams'] if s['codec_type'] == 'video'
                 and not s.get('disposition', {}).get('attached_pic'))
    try:
        format_start = float(info.get('format', {}).get('start_time', 0))
    except (TypeError, ValueError):
        raise TestError('The source has an unsupported media timeline.')
    video_start = stream_seconds(video, 'start_time')
    if not math.isfinite(format_start) or video_start is None:
        raise TestError('The source has an unsupported media timeline.')
    audio = next((s for s in info['streams'] if s['codec_type'] == 'audio'), None)
    coverage = None
    if audio is not None:
        start, length = stream_seconds(audio, 'start_time'), stream_seconds(audio, 'duration')
        try:
            rate = int(audio.get('sample_rate', 0))
        except (TypeError, ValueError):
            rate = 0
        if start is not None and length is not None and length > 0 and rate > 0:
            coverage = dict(start=start-video_start, end=start+length-video_start,
                            sampleRate=rate)
    return dict(video=video, seekOrigin=video_start-format_start,
                videoStart=video_start, audioCoverage=coverage)


def segment_audio_filter(source_length, length, rate=48000):
    # Input seeking already established the shared video-relative origin.
    # Keep real leading/trailing gaps in original moment audio in their original
    # positions. This is not used for a continuous bed, which must be covered.
    # async=1 alone leaves gaps below its default 100ms hard-correction
    # threshold collapsed. Correct real timestamp holes down to one output
    # sample; disable soft compensation explicitly so music is never sped up
    # or slowed down. Continuous beds never use this gap-preserving filter.
    threshold = ff_time(1 / rate)
    return (f'atrim=start=0:end={source_length},aresample={rate}:async=1:first_pts=0:'
            f'min_comp={threshold}:min_hard_comp={threshold}:max_soft_comp=0,'
            f'apad,atrim=duration={length}')


def continuous_audio_source(root, clips, wizard, duration, cancel=None, deadline=None):
    """Validate the actual selected audio interval before rendering pictures.

    Stream extents reject missing heads/tails, including sub-AAC-frame gaps.
    A bounded PCM count additionally rejects missing packets inside that extent.
    Neither check inserts silence, loops, or time-stretches the soundtrack.
    """
    if wizard.get('audioMode') != 'single-source':
        return None
    master = next((c for c in clips if c['id'] == wizard.get('audioClipID')), None)
    start = wizard.get('audioStart', 0)
    if (not master or not master.get('hasAudio') or type(start) not in (int, float)
            or not math.isfinite(start) or start < 0 or not math.isfinite(duration) or duration <= 0):
        raise TestError('Choose an audible source and a finite start for continuous audio.')
    if duration > MAX_CLIP_SECONDS:
        raise TestError('One continuous audio source supports at most five minutes.')
    path = root / master['fileName']
    timing = source_timing(probe(path, cancel))
    coverage = timing['audioCoverage']
    # One source sample allows time-base rounding, not an AAC packet or frame.
    tolerance = 1 / coverage['sampleRate'] + 1e-9 if coverage else 0
    if (not coverage or start < coverage['start'] - tolerance
            or start + duration > coverage['end'] + tolerance):
        raise TestError('The selected continuous audio interval is not fully covered by source audio. Choose another start, a shorter edit, or original audio per moment; it will not loop or pad.')
    seek = timing['seekOrigin'] + start
    timeout = max(60, min(720, math.ceil(duration * 4)))
    if deadline is not None:
        timeout = min(timeout, remaining_render_time(deadline))
    raw = ff(['-ss', ff_time(seek)] + inp(path) +
             ['-map', '0:a:0', '-vn', '-af', f'atrim=start=0:end={duration},aresample=48000',
              '-t', str(duration), '-ac', '1', '-ar', '48000', '-f', 's16le', 'pipe:1'],
             cancel, timeout)
    expected_samples = round(duration * 48000)
    if len(raw) // 2 < expected_samples - 1:
        raise TestError('The selected source has missing audio within this interval. Choose another source or original audio per moment; it will not loop or pad.')
    return dict(path=path, seek=seek)


def color_filter(video):
    if video.get('color_transfer') in ('smpte2084', 'arib-std-b67'):
        return 'zscale=t=linear:npl=100,format=gbrpf32le,tonemap=tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv,'
    return ''


def analyze(path: Path, number: int, cancel: Event):
    # Restrict the demuxer before inspecting untrusted uploads. Playlists must
    # not be able to reference files elsewhere in this development container.
    info = json.loads(run(['ffprobe', '-v', 'error', '-protocol_whitelist', 'file,pipe',
                          '-format_whitelist', 'mov', '-show_streams', '-show_format',
                          '-of', 'json', str(path)], cancel, 30))
    videos = [s for s in info['streams'] if s['codec_type'] == 'video' and not s.get('disposition', {}).get('attached_pic')]
    if not videos or not {'mov', 'mp4', 'm4v'}.intersection(info.get('format', {}).get('format_name', '').split(',')):
        raise TestError('Choose a camera MOV or MP4 video, not a playlist or another file type.')
    video = videos[0]
    timing = source_timing(info)
    duration = float(video.get('duration') or info['format'].get('duration', 0))
    width, height = int(video['width']), int(video['height'])
    if not math.isfinite(duration) or not 0.15 <= duration <= MAX_CLIP_SECONDS + 0.04:
        raise TestError('Each source must be between 0.15 seconds and 5 minutes.')
    if width <= 0 or height <= 0 or max(width, height) > 4096:
        raise TestError('This desktop test supports camera video up to 4K dimensions.')
    rotation = next((float(s.get('rotation', 0)) for s in video.get('side_data_list', []) if 'rotation' in s), 0)
    if round(rotation) % 180 != 0:
        width, height = height, width
    has_audio = any(s['codec_type'] == 'audio' for s in info['streams'])
    audio = []
    if has_audio:
        analysis_timeout = max(180, min(720, math.ceil(duration * 4)))
        raw = ff(['-ss', ff_time(timing['seekOrigin'])] + inp(path) +
                 ['-t', str(duration), '-map', '0:a:0', '-vn',
                  '-af', segment_audio_filter(duration, duration, 16000),
                  '-ac', '1', '-ar', '16000', '-f', 'f32le', 'pipe:1'], cancel, analysis_timeout)
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
    analysis_timeout = max(180, min(720, math.ceil(duration * 4)))
    raw = ff(['-ss', ff_time(timing['seekOrigin'])] + inp(path) + ['-t', str(duration), '-vf', color_filter(video)+'fps=1:start_time=0,scale=64:64,format=gray',
                         '-an', '-f', 'rawvideo', 'pipe:1'], cancel, analysis_timeout)
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
                audioCoverage=timing['audioCoverage'],
                audio=audio, visual=visual, warnings=['Linux image difference is a motion proxy, not camera-shake recognition.'])
    proxy = path.with_suffix('.preview.mp4')
    ff(['-ss', ff_time(timing['seekOrigin'])] + inp(path) + ['-t', str(duration), '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', color_filter(video)+'scale=540:960:force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,fps=30:start_time=0,format=yuv420p',
        '-af', segment_audio_filter(duration, duration),
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-threads', '2', '-c:a', 'aac', '-ar', '48000', '-ac', '2',
        '-map_metadata', '-1', '-movflags', '+faststart', str(proxy)], cancel, analysis_timeout)
    # The proxy keeps its natural aspect ratio. CSS cover + object-position
    # therefore previews the same framing fractions as the final crop.
    ff(['-ss', str(min(duration / 2, 1))] + inp(proxy) + ['-frames:v', '1',
        '-vf', 'scale=180:320:force_original_aspect_ratio=decrease', '-q:v', '5',
        '-an', str(path.with_suffix('.poster.jpg'))], cancel)
    return clip


def settings_from(data):
    if not isinstance(data, dict):
        raise TestError('Expected an edit settings object.')
    result = dict(mode='highlight', style='memory', targetSeconds=15, transitions='automatic',
                  gentleCleanup=False, seamSmoothing=False, stabilize=False, prompt='')
    for key in result:
        if key in data:
            result[key] = data[key]
    allowed = {'mode': ('highlight', 'trailer'),
               'style': ('cinematic', 'hype', 'memory', 'musicVideo', 'surprise'),
               'transitions': ('automatic', 'cuts', 'dissolves')}
    for key, values in allowed.items():
        if not isinstance(result[key], str) or result[key] not in values:
            raise TestError('Unsupported edit option: ' + key)
    if type(result['targetSeconds']) not in (int, float) or result['targetSeconds'] not in SUPPORTED_TARGET_SECONDS:
        raise TestError('Choose a 15-, 30-, 45-, 60-, 90-, 120-, 180-, or 300-second target.')
    if not isinstance(result['prompt'], str) or len(result['prompt']) > 1500:
        raise TestError('Keep your direction under 1,500 characters.')
    if (type(result['gentleCleanup']) is not bool or type(result['seamSmoothing']) is not bool
            or result['stabilize'] is not False):
        raise TestError('Unsupported cleanup or stabilization setting.')
    return result


def output_profile(target_seconds, aspect_ratio='9:16'):
    """Return the declared export profile for an allowed user selection.

    Long form stays vertical and 30fps, but uses 720p so a private two-core
    Codespace can finish a five-minute compilation without silently reducing
    fidelity after the user has already reviewed the edit.
    """
    if target_seconds not in SUPPORTED_TARGET_SECONDS:
        raise TestError('Choose a supported target before selecting an export profile.')
    dimensions = {'9:16': (720, 1280) if target_seconds > 60 else (1080, 1920),
                  '16:9': (1280, 720) if target_seconds > 60 else (1920, 1080),
                  '1:1': (720, 720) if target_seconds > 60 else (1080, 1080)}
    if aspect_ratio not in dimensions:
        raise TestError('Choose 9:16, 16:9, or 1:1.')
    width, height = dimensions[aspect_ratio]
    return dict(name=f'{width}×{height} {aspect_ratio}', width=width, height=height, crf=22 if target_seconds > 60 else 20)


def direct(root, clips, settings, cancel, plan=None, previous=None, seed=0, explicit_settings=None):
    request = dict(clips=clips, settings=settings, action='validate' if plan is not None else 'plan', plan=plan, previous=previous, seed=seed,
                   explicitSettings=explicit_settings or [])
    source, target = root/'request.json', root/'response.json'
    source.write_text(json.dumps(request, allow_nan=False))
    try:
        planner_timeout = max(30, min(120, math.ceil(float(settings['targetSeconds']) / 2)))
        run([str(CLI), str(source), str(target)], cancel, planner_timeout)
        return json.loads(target.read_text())
    finally:
        source.unlink(missing_ok=True); target.unlink(missing_ok=True)


def render(root, clips, directed, cancel, progress, preview=False):
    """Publish only verified output; on failure keep originals but delete partials."""
    for p in list(root.glob('segment-*.*')) + list(root.glob('piece-*.*')) + [root / 'pending.mp4', root / 'assembly.ffconcat']:
        p.unlink(missing_ok=True)
    try:
        return _render(root, clips, directed, cancel, progress, preview)
    except BaseException:
        for p in list(root.glob('segment-*.*')) + list(root.glob('piece-*.*')) + [root / 'pending.mp4', root / 'assembly.ffconcat']:
            p.unlink(missing_ok=True)
        raise


def frame_timeline(timeline):
    """Round absolute boundaries, not each length, to avoid cumulative drift.

    The edit remains on its original timebase outside this rendering adapter.
    A boundary shifts at most half an output frame. Source reads never extend
    beyond an approved trim; any fractional tail is padded, not newly selected.
    """
    shots = copy.deepcopy(timeline)
    previous_end = 0
    for index, shot in enumerate(shots):
        # CompassCore rounds its cursor to 1/600 s after each shot. Reuse
        # the next canonical boundary rather than re-adding unrounded input
        # durations; a half-frame tie can otherwise create a phantom gap.
        raw_end = shot['at'] + shot['moment']['duration']
        canonical_end = (timeline[index+1]['at'] + timeline[index+1]['overlap']) if index+1 < len(shots) else raw_end
        if abs(canonical_end - raw_end) > .004:
            raise TestError('The edit has an actual timing gap or overlap mismatch.')
        start_ticks = int(math.floor(shot['at']*600 + .5 + 1e-8))
        end_ticks = int(math.floor(canonical_end*600 + .5 + 1e-8))
        start = (start_ticks + 10) // 20
        end = (end_ticks + 10) // 20
        if end <= start or start < 0 or (index and start > previous_end):
            raise TestError('This edit cannot be aligned to output video frames.')
        shot['_sourceDuration'] = shot['moment']['duration']
        shot['at'] = start / 30
        shot['moment']['duration'] = (end - start) / 30
        shot['overlap'] = (previous_end - start) / 30 if index else 0
        if shot['overlap'] == 0:
            shot['incoming'] = 'cut'
        previous_end = end
    return shots


def render_deadline(duration):
    # Bound total work while leaving enough time for the intentionally
    # lower-resolution five-minute profile on two CPU cores.
    return time.monotonic() + max(600, min(2700, math.ceil(duration * 8)))


def remaining_render_time(deadline, floor=1):
    remaining = math.ceil(deadline - time.monotonic())
    if remaining < floor:
        raise TestError('This render exceeded its safe time budget. Try a shorter compilation.')
    return remaining


def _render(root, clips, directed, cancel, progress, preview=False):
    shots = frame_timeline(directed['timeline'])
    if not shots or len(shots) > MAX_RENDER_MOMENTS:
        raise TestError(f'This desktop test supports up to {MAX_RENDER_MOMENTS} moments.')
    by_id = {c['id']: c for c in clips}
    segments = []
    duration = shots[-1]['at'] + shots[-1]['moment']['duration']
    settings = directed['plan']['settings']
    wizard = directed.get('wizard', {})
    deadline = render_deadline(duration)
    master_audio = continuous_audio_source(root, clips, wizard, duration, cancel, deadline)
    profile = output_profile(settings['targetSeconds'], wizard.get('aspectRatio', '9:16'))
    audio_policy = AudioPolicy.from_settings(settings)
    if settings.get('stabilize'):
        raise TestError('This test does not implement stabilization.')
    for i, shot in enumerate(shots):
        progress(i/len(shots)*.65, f'Rendering selected moments ({i+1} of {len(shots)})')
        moment = shot['moment']; clip = by_id[moment['clipID']]
        source = root / clip['fileName']
        length = moment['duration']
        source_length = shot['_sourceDuration']
        timing = source_timing(probe(source, cancel))
        video = timing['video']
        target = root / f'segment-{i}.mkv'
        args = ['-ss', ff_time(timing['seekOrigin'] + moment['start'])] + inp(source)
        audible = clip['hasAudio'] and not moment['muted']
        coverage = timing['audioCoverage']
        if coverage and (moment['start'] >= coverage['end'] or
                         moment['start'] + source_length <= coverage['start']):
            audible = False  # This original video interval has no source audio.
        if not audible: args += ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']
        vf = f'trim=start=0:end={source_length},tpad=stop_mode=clone:stop_duration=0.067,'+color_filter(video)+f'scale={profile["width"]}:{profile["height"]}:force_original_aspect_ratio=increase,crop={profile["width"]}:{profile["height"]}:(iw-ow)*{moment["focusX"]}:(ih-oh)*{moment["focusY"]},setsar=1,fps=30:start_time=0,format=yuv420p'
        af = segment_audio_filter(source_length, length)
        af += audio_policy.segment_suffix()
        args += ['-map','0:v:0','-map','0:a:0' if audible else '1:a:0', '-t',str(length), '-vf',vf, '-af',af,
                 '-c:v','libx264','-preset','veryfast','-crf',str(profile['crf']),'-threads','2','-x264-params','colorprim=bt709:transfer=bt709:colormatrix=bt709',
                 '-c:a','pcm_s16le','-ar','48000','-ac','2','-map_metadata','-1',
                 '-color_primaries','bt709','-color_trc','bt709','-colorspace','bt709',str(target)]
        segment_timeout = min(remaining_render_time(deadline), max(180, min(600, math.ceil(length * 30))))
        ff(args,cancel,segment_timeout); segments.append(target); progress((i+1)/len(shots)*.65, 'Rendering selected moments')
    pending = assemble_bounded(root, segments, shots, duration, cancel, progress, audio_policy, profile, deadline)
    if master_audio:
        remux = root / 'master-pending.mp4'
        ff(['-ss', ff_time(master_audio['seek'])] + inp(master_audio['path']) + inp(pending) +
           ['-map','1:v:0','-map','0:a:0','-t',str(duration),
            '-af',f'atrim=start=0:end={duration}',
            '-c:v','copy','-c:a','aac','-b:a','192k','-ar','48000','-ac','2','-map_metadata','-1','-movflags','+faststart',str(remux)], cancel, remaining_render_time(deadline))
        pending.unlink(); remux.replace(pending)
    progress(.94, 'Decoding the complete output and checking sound timing')
    verify(pending,duration,cancel,profile,deadline)
    if cancel.is_set():
        raise TestError('Stopped safely. No partial reel is shareable.')
    final=root/('preview.mp4' if preview else 'reel.mp4'); pending.replace(final)
    # Preview preserves source copies for revision; final export alone cleans them.
    for p in root.iterdir():
        if p.is_file() and p != final and (not preview or p.name.startswith(('segment-', 'piece-', 'pending', 'assembly'))): p.unlink()
    progress(1, 'Preview ready. Sources are retained for changes.' if preview else 'Full reel ready. Source copies have been deleted.')
    return final


def finalize_preview(root: Path):
    preview, final = root/'preview.mp4', root/'reel.mp4'
    if not preview.is_file():
        raise TestError('The current preview is unavailable. Render a new preview before export.')
    preview.replace(final)
    for p in root.iterdir():
        if p.is_file() and p != final: p.unlink()
    return final


def assemble_bounded(root, segments, shots, duration, cancel, progress, audio_policy=None, profile=None, deadline=None):
    """Render nonoverlapping bodies and transition windows, then stream-concat.

    At most TWO decoded videos are live at once. The prior all-input graph
    failed the 60-second test in a 4 GiB container with an OOM kill recorded. PCM intermediates avoid an AAC padding error at every splice.
    Only generated relative filenames enter the concat manifest.
    """
    pieces = []
    # Keep raw source audio as the default.  The policy can only refine an
    # overlap already selected by the approved visual timeline; it must never
    # manufacture an audio overlap at a hard cut.
    audio_policy = audio_policy or AudioPolicy()
    profile = profile or output_profile(15)
    encoder = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', str(profile['crf']), '-threads', '2',
               '-x264-params', 'colorprim=bt709:transfer=bt709:colormatrix=bt709',
               '-c:a', 'pcm_s16le', '-ar', '48000', '-ac', '2', '-map_metadata', '-1',
               '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709']

    def video_trim(index, first, last, label):
        return f'[{index}:v]trim=start_frame={first}:end_frame={last},setpts=PTS-STARTPTS,fps=30,settb=AVTB[{label}]'

    def audio_trim(index, first, last, label):
        return f'[{index}:a]atrim=start_sample={first*1600}:end_sample={last*1600},asetpts=PTS-STARTPTS[{label}]'

    def piece(args, graph, frames):
        if frames <= 0:
            return
        target = root / f'piece-{len(pieces):03d}.mkv'
        timeout = max(180, min(600, math.ceil(frames / 30 * 30)))
        if deadline is not None:
            timeout = min(timeout, remaining_render_time(deadline))
        ff(args + ['-filter_complex', ';'.join(graph), '-map', '[v]', '-map', '[a]',
                   '-t', str(frames/30)] + encoder + [str(target)], cancel, timeout)
        pieces.append((target, frames))

    for i, shot in enumerate(shots):
        incoming = round(shot['overlap']*30)
        length = round(shot['moment']['duration']*30)
        outgoing = round(shots[i+1]['overlap']*30) if i+1 < len(shots) else 0
        if incoming:
            previous_length = round(shots[i-1]['moment']['duration']*30)
            graph = [video_trim(0, previous_length-incoming, previous_length, 'va'),
                     video_trim(1, 0, incoming, 'vb'),
                     f'[va][vb]xfade=transition=fade:duration={incoming/30}:offset=0,fps=30,format=yuv420p[v]',
                     audio_trim(0, previous_length-incoming, previous_length, 'aa'),
                     audio_trim(1, 0, incoming, 'ab'),
                     f'[aa][ab]{audio_policy.seam_filter(incoming/30) or f"acrossfade=d={incoming/30}:c1=tri:c2=tri"}[a]']
            piece(inp(segments[i-1])+inp(segments[i]), graph, incoming)
        graph = [video_trim(0, incoming, length-outgoing, 'v'),
                 audio_trim(0, incoming, length-outgoing, 'a')]
        piece(inp(segments[i]), graph, length-incoming-outgoing)
        progress(.65 + .25*(i+1)/len(shots), 'Finishing transitions with bounded memory')
    total_frames = sum(frames for _, frames in pieces)
    if abs(total_frames/30-duration) > .001:
        raise TestError('Piece assembly did not preserve the complete edit length.')
    manifest = root / 'assembly.ffconcat'
    manifest.write_text('ffconcat version 1.0\n' + ''.join(
        f"file '{path.name}'\nduration {frames/30:.12f}\n" for path,frames in pieces))
    pending = root / 'pending.mp4'
    final_timeout = max(180, min(900, math.ceil(duration * 2)))
    if deadline is not None:
        final_timeout = min(final_timeout, remaining_render_time(deadline))
    ff(['-f', 'concat', '-safe', '1'] + inp(manifest) +
       ['-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy',
        '-af', f'aresample=48000:async=1:first_pts=0,apad,atrim=duration={duration}',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
        '-t', str(duration), '-map_metadata', '-1', '-video_track_timescale', '90000',
        '-movflags', '+faststart', str(pending)], cancel, final_timeout)
    return pending


def verify(path, expected, cancel, profile=None, deadline=None):
    profile = profile or output_profile(15)
    info=probe(path,cancel)
    v=next((s for s in info['streams'] if s['codec_type']=='video'),{})
    a=next((s for s in info['streams'] if s['codec_type']=='audio'),{})
    if (v.get('codec_name'),v.get('width'),v.get('height'),a.get('codec_name')) != ('h264',profile['width'],profile['height'],'aac'):
        raise TestError('Output codec or dimensions failed validation. No reel was published.')
    if abs(float(info['format']['duration'])-expected)>.16:
        raise TestError('The full duration failed verification. No partial reel was published.')
    for t in (0,expected/2,max(0,expected-.15)):
        sample_timeout = 30 if deadline is None else min(30, remaining_render_time(deadline))
        frame=ff(['-ss',str(t)]+inp(path)+['-frames:v','1','-vf','scale=32:32','-an','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],cancel,sample_timeout)
        if len(frame)!=3072: raise TestError('A first, middle or final frame failed to decode.')

    # A few thumbnail samples are not proof that the full output decodes.
    decode_timeout = max(120, min(900, math.ceil(expected * 2)))
    if deadline is not None:
        decode_timeout = min(decode_timeout, remaining_render_time(deadline))
    ff(['-xerror'] + inp(path) + ['-map', '0:v:0', '-map', '0:a:0',
        '-f', 'null', '-'], cancel, decode_timeout)
    vs, vd = stream_seconds(v, 'start_time'), stream_seconds(v, 'duration')
    aus, ad = stream_seconds(a, 'start_time'), stream_seconds(a, 'duration')
    # AAC's final packet can extend by one 1024-sample frame. This codec
    # allowance is NOT the source-coverage test, which runs before rendering.
    audio_tolerance = 1024 / 48000 + .002
    if (None in (vs, vd, aus, ad) or abs(vs) > .002 or abs(aus) > .002
            or abs(vs + vd - expected) > 1 / 30 + .002
            or abs(aus + ad - expected) > audio_tolerance):
        raise TestError('Video and audio start or end positions disagree. This reel was not published.')
    if path.stat().st_size > MAX_OUTPUT_BYTES:
        raise TestError('The completed reel is too large for this private desktop export.')
