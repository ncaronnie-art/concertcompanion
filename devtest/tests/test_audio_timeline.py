"""Generated-media regression tests for source audio timing and coverage.

The planner is not invoked: explicit approved timelines go through the real
renderer. Only its output dimensions are reduced to bound test cost.
No source footage, remote service, normalization, or listening claim.
"""
import array
import json
import shutil
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import engine
import server


PROFILE = dict(name='generated 160x90', width=160, height=90, crf=18)


class AudioTimelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='compass-audio-timeline-generated-')
        cls.fixtures = Path(cls.temp.name)
        cls.sources = {}
        for rate in (44100, 48000):
            for name, video_start, audio_start in (('late', 0, .25), ('early', .3, 0),
                                                   ('both-offset', .3, .55), ('aligned', 0, 0)):
                path = cls.fixtures / f'{rate}-{name}.mov'
                pulse = video_start + .5 - audio_start
                tone = f'if(between(t\\,{pulse}\\,{pulse+.1})\\,0.8*sin(2*PI*1000*t)\\,0)'
                engine.ff(['-itsoffset', str(video_start), '-f', 'lavfi', '-i',
                    'color=black:s=160x90:r=30:d=3,drawbox=color=white:t=fill:enable=between(t\\,0.5\\,0.6)',
                    '-itsoffset', str(audio_start), '-f', 'lavfi', '-i',
                    f'aevalsrc={tone}|0.5*{tone}:s={rate}:d=3',
                    # FFmpeg 6.1's automatic video sync duplicates the first
                    # frames to fill a positive offset. Preserve timestamps
                    # explicitly so every supported version tests the same
                    # early/late stream relationship, not a different source.
                    '-c:v', 'libx264', '-preset', 'ultrafast', '-fps_mode', 'passthrough',
                    '-c:a', 'pcm_s16le', str(path)])
                cls.sources[rate, name] = path

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def setUp(self):
        self.work = tempfile.TemporaryDirectory(dir=self.fixtures, prefix='render-')
        self.root = Path(self.work.name)
        self.cancel = threading.Event()

    def tearDown(self):
        self.work.cleanup()

    def clip(self, source):
        path = self.root / source.name
        shutil.copyfile(source, path)
        info = engine.probe(path)
        video = next(s for s in info['streams'] if s['codec_type'] == 'video')
        return dict(id=path.stem, fileName=path.name, name='Generated',
                    duration=float(video['duration']), hasAudio=True, width=160, height=90)

    def plan(self, clip, start=0, length=2, mode='selected-moment-original', audio_start=0):
        moment = dict(id='generated-moment', clipID=clip['id'], start=start, duration=length,
                      muted=False, approved=True, locked=True, focusX=.5, focusY=.5)
        wizard = dict(audioMode=mode, audioClipID=clip['id'], audioStart=audio_start,
                      aspectRatio='16:9')
        return dict(plan=dict(settings=engine.settings_from({}), moments=[moment]),
                    timeline=[dict(at=0, overlap=0, incoming='cut', moment=moment)], wizard=wizard)

    def render(self, clip, **kwargs):
        with patch.object(engine, 'output_profile', return_value=PROFILE):
            return engine.render(self.root, [clip], self.plan(clip, **kwargs),
                                 self.cancel, lambda *_: None, preview=True)

    def pcm(self, args, rate=48000):
        result = array.array('f')
        result.frombytes(engine.ff(args + ['-ac', '1', '-ar', str(rate), '-f', 'f32le', 'pipe:1']))
        if sys.byteorder != 'little':
            result.byteswap()
        return result

    def onset(self, samples):
        return next((i/48000 for i, value in enumerate(samples) if abs(value) > .1), None)

    def test_generated_offsets_are_real_stream_offsets_without_duplicate_frames(self):
        offsets = {'late': (0, .25), 'early': (.3, 0),
                   'both-offset': (.3, .55), 'aligned': (0, 0)}
        for (rate, name), source in self.sources.items():
            with self.subTest(rate=rate, source=name):
                streams = engine.probe(source)['streams']
                video = next(s for s in streams if s['codec_type'] == 'video')
                audio = next(s for s in streams if s['codec_type'] == 'audio')
                expected_video, expected_audio = offsets[name]
                self.assertAlmostEqual(float(video['start_time']), expected_video, delta=.000001)
                self.assertAlmostEqual(float(audio['start_time']), expected_audio, delta=.000001)
                self.assertAlmostEqual(float(video['duration']), 3, delta=.000001)
                self.assertEqual(int(video['nb_frames']), 90)

    def test_pcm_preserves_shared_origin_for_early_late_and_offset_sources(self):
        for (rate, name), source in self.sources.items():
            timing = engine.source_timing(engine.probe(source))
            for start in (0, .3):
                with self.subTest(rate=rate, source=name, trim=start):
                    samples = self.pcm(['-ss', str(timing['seekOrigin'] + start)] + engine.inp(source) +
                        ['-map', '0:a:0', '-vn', '-t', '2', '-af', engine.segment_audio_filter(2, 2)])
                    self.assertEqual(len(samples), 96000)
                    self.assertAlmostEqual(self.onset(samples), .5-start, delta=1/48000+1e-9)

    def test_final_aac_and_picture_remain_aligned_for_early_and_late_sources(self):
        for rate in (44100, 48000):
            for name in ('early', 'late', 'both-offset'):
                clip = self.clip(self.sources[rate, name])
                for start in (0, .3):
                    with self.subTest(rate=rate, source=name, trim=start):
                        output = self.render(clip, start=start)
                        samples = self.pcm(engine.inp(output) + ['-vn'])
                        self.assertAlmostEqual(self.onset(samples), .5-start, delta=.002)
                        frames = engine.ff(engine.inp(output) + ['-an', '-vf', 'scale=1:1,format=gray',
                                                                  '-f', 'rawvideo', 'pipe:1'])
                        flash = next(i/30 for i, value in enumerate(frames) if value > 150)
                        self.assertAlmostEqual(flash, .5-start, delta=1/30+1e-9)

    def test_original_timestamp_gap_is_preserved_but_not_allowed_as_continuous_bed(self):
        clip = self.clip(self.sources[48000, 'late'])
        output = self.render(clip)
        samples = self.pcm(engine.inp(output) + ['-vn'])
        self.assertLess(max(abs(x) for x in samples[:int(.2*48000)]), .001)
        self.assertAlmostEqual(self.onset(samples), .5, delta=.002)
        with patch.object(engine, 'assemble_bounded', side_effect=AssertionError('Must reject before pictures')):
            with self.assertRaisesRegex(engine.TestError, 'not fully covered'):
                self.render(clip, mode='single-source', audio_start=0)

    def test_continuous_aac_uses_video_relative_start_without_moving_the_song(self):
        for rate in (44100, 48000):
            for name, audio_start in (('early', 0), ('late', .25), ('both-offset', .3)):
                with self.subTest(rate=rate, source=name):
                    clip = self.clip(self.sources[rate, name])
                    output = self.render(clip, mode='single-source', audio_start=audio_start)
                    samples = self.pcm(engine.inp(output) + ['-vn'])
                    self.assertAlmostEqual(self.onset(samples), .5-audio_start, delta=.002)

    def test_exact_coverage_accepted_and_59ms_tail_rejected_before_ffmpeg_render(self):
        for rate in (44100, 48000):
            for length in (2, 1.94):
                source = self.root / f'coverage-{rate}-{length}.mp4'
                engine.ff(['-f', 'lavfi', '-i', 'color=black:s=160x90:r=30:d=3',
                    '-f', 'lavfi', '-i', f'sine=frequency=1000:sample_rate={rate}:duration={length}',
                    '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', str(source)])
                clip = dict(id=source.stem, fileName=source.name, duration=3, hasAudio=True)
                wizard = self.plan(clip, mode='single-source')['wizard']
                with self.subTest(rate=rate, coverage=length):
                    if length == 2:
                        self.assertIsNotNone(engine.continuous_audio_source(self.root, [clip], wizard, 2))
                    else:
                        with patch.object(engine, 'ff', side_effect=AssertionError('No render/decode needed')):
                            with self.assertRaisesRegex(engine.TestError, 'not fully covered'):
                                engine.render(self.root, [clip], self.plan(clip, mode='single-source'),
                                              self.cancel, lambda *_: None, preview=True)

    def test_internal_missing_packets_are_not_filled_to_satisfy_coverage(self):
        source = self.root / 'packet-gap.mp4'
        engine.ff(['-f', 'lavfi', '-i', 'color=black:s=160x90:r=30:d=3',
            '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000:duration=3',
            '-af', 'aselect=not(between(t\\,0.4\\,0.6))',
            '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', str(source)])
        clip = dict(id=source.stem, fileName=source.name, duration=3, hasAudio=True)
        coverage = engine.source_timing(engine.probe(source))['audioCoverage']
        self.assertGreaterEqual(coverage['end'], 2)
        with self.assertRaisesRegex(engine.TestError, 'missing audio within'):
            engine.continuous_audio_source(self.root, [clip], self.plan(clip, mode='single-source')['wizard'], 2)

    def test_unknown_extent_and_nonfinite_starts_fail_closed(self):
        clip = self.clip(self.sources[48000, 'aligned'])
        wizard = self.plan(clip, mode='single-source')['wizard']
        for invalid in (float('nan'), float('inf'), True, -1):
            with self.subTest(start=invalid):
                with self.assertRaises(engine.TestError):
                    engine.continuous_audio_source(self.root, [clip], {**wizard, 'audioStart': invalid}, 2)
                with self.assertRaises(engine.TestError):
                    server.wizard_from({'wizard': {**wizard, 'audioStart': invalid}}, clips=[clip])
        info = engine.probe(self.root / clip['fileName'])
        for stream in info['streams']:
            if stream['codec_type'] == 'audio':
                stream.pop('duration', None); stream.pop('duration_ts', None)
        with patch.object(engine, 'probe', return_value=info):
            with self.assertRaisesRegex(engine.TestError, 'not fully covered'):
                engine.continuous_audio_source(self.root, [clip], wizard, 2)

    def test_verifier_rejects_missing_tail_and_equal_duration_shifted_start(self):
        for label, start, duration in (('tail', 0, 1.94), ('shift', .1, 2)):
            path = self.root / f'bad-{label}.mp4'
            engine.ff(['-f', 'lavfi', '-i', 'color=black:s=160x90:r=30:d=2',
                '-itsoffset', str(start), '-f', 'lavfi', '-i',
                f'sine=frequency=1000:sample_rate=48000:duration={duration}',
                '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', str(path)])
            with self.subTest(case=label):
                with self.assertRaisesRegex(engine.TestError, 'start or end positions'):
                    engine.verify(path, 2, self.cancel, PROFILE)

    def test_analyzer_and_proxy_share_video_relative_timing(self):
        for name in ('early', 'late'):
            source = self.root / f'analysis-{name}.mov'
            shutil.copyfile(self.sources[44100, name], source)
            clip = engine.analyze(source, 1, self.cancel)
            self.assertIn('audioCoverage', clip)
            # Analysis bins and proxy now use the same clip-time origin.
            peak_bin = max(clip['audio'], key=lambda x: x['energy'])['time']
            self.assertAlmostEqual(peak_bin, .5, delta=.1)
            samples = self.pcm(engine.inp(source.with_suffix('.preview.mp4')) + ['-vn'])
            self.assertAlmostEqual(self.onset(samples), .5, delta=.002)

    def test_original_window_before_audio_and_silent_source_keep_their_real_silence(self):
        clip = self.clip(self.sources[48000, 'late'])
        output = self.render(clip, start=0, length=.1)
        self.assertLess(max(abs(x) for x in self.pcm(engine.inp(output) + ['-vn'])), .001)
        silent = self.root / 'silent.mov'
        engine.ff(['-f', 'lavfi', '-i', 'color=black:s=160x90:r=30:d=1',
                   '-c:v', 'libx264', '-preset', 'ultrafast', '-an', str(silent)])
        analyzed = engine.analyze(silent, 1, self.cancel)
        self.assertFalse(analyzed['hasAudio'])
        self.assertIsNone(analyzed['audioCoverage'])

    def test_tiny_valid_seek_does_not_become_invalid_scientific_notation(self):
        clip = self.clip(self.sources[48000, 'aligned'])
        result = engine.continuous_audio_source(self.root, [clip],
            self.plan(clip, mode='single-source', audio_start=1e-7)['wizard'], 2)
        self.assertIsNotNone(result)

    def test_small_and_large_packet_gaps_preserve_original_frame_timestamps_in_all_paths(self):
        """Source truth comes from decoded-frame PTS, not concatenated raw PCM.

        Regresses independent QA's one/few-packet holes below the resampler's
        old 100ms default threshold, with a larger hole as a control.
        """
        for rate in (44100, 48000):
            for gap_stop in (.72, .75, .9):
                with self.subTest(rate=rate, gap_stop=gap_stop):
                    source = self.root / f'gap-{rate}-{gap_stop}.mov'
                    tone = 'if(between(t\\,1.2\\,1.28)\\,0.8*sin(2*PI*997*t)\\,0)'
                    engine.ff(['-f', 'lavfi', '-i', 'color=black:s=160x90:r=30:d=3',
                        '-f', 'lavfi', '-i', f'aevalsrc={tone}:s={rate}:d=3',
                        '-af', f'aselect=not(between(t\\,0.69\\,{gap_stop}))',
                        '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', str(source)])
                    frames = json.loads(engine.run(['ffprobe', '-v', 'error', '-select_streams', 'a:0',
                        '-show_frames', '-show_entries', 'frame=pts_time,nb_samples',
                        '-of', 'json', str(source)]))['frames']
                    raw = self.pcm(engine.inp(source) + ['-vn'], rate)
                    self.assertEqual(len(raw), sum(int(f['nb_samples']) for f in frames))
                    onset_index = next(i for i, value in enumerate(raw) if abs(value) > .1)
                    cursor = 0
                    for frame in frames:
                        count = int(frame['nb_samples'])
                        if cursor <= onset_index < cursor + count:
                            source_time = float(frame['pts_time']) + (onset_index-cursor)/rate
                            break
                        cursor += count
                    else:
                        self.fail('Could not map decoded samples to source timestamps')
                    self.assertAlmostEqual(source_time, 1.2, delta=1/rate)
                    self.assertGreater(source_time-onset_index/rate, .02)

                    # Direct 48k segment and 16k analysis paths: one output
                    # sample plus one source sample bounds resampling onset.
                    for output_rate in (16000, 48000):
                        filtered = self.pcm(engine.inp(source) + ['-vn', '-t', '1.8', '-af',
                            engine.segment_audio_filter(1.8, 1.8, output_rate)], output_rate)
                        event = next(i/output_rate for i, value in enumerate(filtered) if abs(value) > .1)
                        self.assertEqual(len(filtered), round(1.8*output_rate))
                        self.assertAlmostEqual(event, source_time, delta=1/output_rate+1/rate)

                    clip = dict(id=source.stem, fileName=source.name, duration=3,
                                hasAudio=True, width=160, height=90)
                    output = self.render(clip, length=1.8)
                    self.assertAlmostEqual(self.onset(self.pcm(engine.inp(output)+['-vn'])),
                                           source_time, delta=.002)
                    engine.analyze(source, 1, self.cancel)
                    proxy = source.with_suffix('.preview.mp4')
                    self.assertAlmostEqual(self.onset(self.pcm(engine.inp(proxy)+['-vn'])),
                                           source_time, delta=.002)
                    # Preserving an original gap is not satisfying a continuous
                    # soundtrack promise. All six missing intervals still fail.
                    with self.assertRaisesRegex(engine.TestError, 'missing audio within'):
                        engine.continuous_audio_source(self.root, [clip],
                            self.plan(clip, mode='single-source')['wizard'], 1.8)

    def test_original_gap_filter_disables_soft_time_compensation(self):
        for rate in (16000, 48000):
            fragment = engine.segment_audio_filter(2, 2, rate)
            self.assertIn(':async=1:', fragment)
            self.assertIn(':max_soft_comp=0', fragment)
            self.assertIn(f':min_hard_comp={1/rate:.9f}', fragment)


if __name__ == '__main__':
    unittest.main(verbosity=2)
