"""Intact-mode contract tests. Generated inputs only; CLI tests require real Swift.

Run with the real built QualityCLI before publishing. Source assertions are not
claimed as executed Swift integration. Renderer fixtures use actual FFmpeg.
"""
import array
import copy
import json
import math
import shutil
import sys
import tempfile
import threading
import unittest
import uuid
import wave
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import engine
import server


def clip(seconds, name='generated.mov'):
    return dict(id=str(uuid.uuid4()).upper(), name=name, fileName=name, duration=seconds,
                width=160, height=90, hasAudio=True, mediaStart=0, audio=[], visual=[], warnings=[])


def moment(source, start=0, length=None, **values):
    return dict(id=str(uuid.uuid4()).upper(), clipID=source['id'], start=start,
                duration=length if length is not None else source['duration'], role='build', score=0,
                reason='Generated selected section', approved=values.get('approved', True),
                locked=values.get('locked', True), muted=False, focusX=.5, focusY=.5)


class IntactContractTests(unittest.TestCase):
    def test_mode_is_explicit_and_boolean_only(self):
        self.assertFalse(engine.settings_from({})['preserveSections'])
        self.assertTrue(engine.settings_from({'preserveSections': True})['preserveSections'])
        for invalid in (1, 'true', [], None):
            with self.assertRaises(engine.TestError):
                engine.settings_from({'preserveSections': invalid})

    def test_actual_long_duration_controls_profile_and_confirmation(self):
        settings = engine.settings_from({'targetSeconds': 30, 'preserveSections': True})
        self.assertEqual(engine.render_target(settings, 115), 120)
        self.assertEqual(engine.output_profile(engine.render_target(settings, 115))['width'], 720)
        directed = {'plan': {'settings': settings}, 'timeline': [{'moment': {'duration': 115}}]}
        with self.assertRaisesRegex(engine.TestError, '115.0s'):
            server.require_directed_compilation_approval(directed, False)
        server.require_directed_compilation_approval(directed, True)
        self.assertEqual(engine.render_target(engine.settings_from({'targetSeconds': 30}), 115), 30)

    def test_annotation_does_not_suggest_shuffling_intact_sections(self):
        sources = [clip(5), clip(6)]
        moments = [moment(sources[1]), moment(sources[0])]
        value = dict(plan=dict(settings=engine.settings_from({'preserveSections': True}), moments=moments),
                     timeline=[dict(at=0, moment=moments[0]), dict(at=6, moment=moments[1])])
        original = copy.deepcopy(value['plan'])
        annotated = server.annotate(value, sources)
        self.assertIsNone(annotated['editorialProposal'])
        self.assertEqual(annotated['plan'], original)
        self.assertEqual(annotated['seconds'], 11)

    def test_stale_adapter_cannot_silently_produce_highlights(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            def old_adapter(*args):
                (root/'response.json').write_text(json.dumps({'plan': {'settings': {}}, 'timeline': []}))
            with patch.object(engine, 'run', side_effect=old_adapter):
                with self.assertRaisesRegex(engine.TestError, 'Rebuild'):
                    engine.direct(root, [], engine.settings_from({'preserveSections': True}), threading.Event())
            self.assertFalse((root/'request.json').exists())
            self.assertFalse((root/'response.json').exists())

    def test_many_fractional_sections_have_no_cumulative_picture_drift(self):
        source = clip(12)
        moments = [moment(source, i*.101, .101) for i in range(100)]
        core_cursor = 0
        timeline = []
        for m in moments:
            timeline.append(dict(at=core_cursor, overlap=0, incoming='cut', moment=m))
            core_cursor = math.floor((core_cursor + m['duration'])*600+.5)/600
        shots, duration = engine.intact_frame_timeline(timeline)
        self.assertAlmostEqual(duration, 10.1, places=8)
        for i, shot in enumerate(shots):
            self.assertLessEqual(abs(shot['at'] - i*.101), 1/30)
        self.assertLessEqual(shots[-1]['at'] + shots[-1]['moment']['duration'] - duration, 1/30)

    def test_exact_limit_retains_bounded_samples_without_rejecting_or_truncating(self):
        for durations in ([100.0000125, 100.0000125, 99.999975], [300/7]*7, [150, 150]):
            with self.subTest(durations=durations):
                timeline = [dict(at=0, overlap=0, incoming='cut', moment=dict(duration=d)) for d in durations]
                original = copy.deepcopy(timeline)
                shots, sampled = engine.intact_frame_timeline(timeline)
                self.assertEqual(engine.validate_intact_duration(timeline, sampled), 300)
                expected = sum(round(d*48000) for d in durations)
                self.assertEqual(round(sampled*48000), expected)
                self.assertEqual(expected, 14400000 if len(durations)==2 else 14400001)
                self.assertEqual(timeline, original)
                self.assertLessEqual(shots[-1]['at'] + shots[-1]['moment']['duration'] - sampled, 1/30)

    def test_semantic_limit_is_not_relaxed_by_sample_tolerance(self):
        for duration in (300.001, 300.000001):
            timeline = [dict(moment=dict(duration=duration))]
            with self.assertRaisesRegex(engine.TestError, 'exceed 300s'):
                engine.validate_intact_duration(timeline, round(duration*48000)/48000)
        timeline = [dict(moment=dict(duration=100)) for _ in range(3)]
        with self.assertRaisesRegex(engine.TestError, 'bounded output-sample rounding'):
            engine.validate_intact_duration(timeline, (14400000+2)/48000)

    def test_continuous_bed_rounds_one_interval_without_extra_section_sample(self):
        source = clip(300)
        durations = [100.0000125, 100.0000125, 99.999975]
        moments = [moment(source, 0, d) for d in durations]
        timeline = [dict(at=0, overlap=0, incoming='cut', moment=m) for m in moments]
        directed = dict(plan=dict(settings=engine.settings_from({'preserveSections': True}), moments=moments),
                        timeline=timeline, wizard=dict(audioMode='single-source'))
        class ReachedCoverage(Exception):
            pass
        def coverage(root, clips, wizard, duration, *args):
            self.assertEqual(duration, 300)
            self.assertEqual(round(duration*48000), 14400000)
            raise ReachedCoverage()
        with tempfile.TemporaryDirectory() as tmp, patch.object(engine, 'continuous_audio_source', side_effect=coverage):
            with self.assertRaises(ReachedCoverage):
                engine.render(Path(tmp), [source], directed, threading.Event(), lambda *_: None, preview=True)

    def test_native_model_unchanged_and_core_validation_is_used(self):
        adapter = (engine.HERE/'Sources/QualityCLI/main.swift').read_text()
        self.assertIn('timingPlan.settings.transitions = .cuts', adapter)
        self.assertIn('try Timeline.validate(timingPlan, clips: r.clips)', adapter)
        self.assertIn('try Timeline.build(timingPlan)', adapter)
        self.assertIn('moments = previous.moments', adapter)
        self.assertIn('try Planner.propose', adapter)
        self.assertEqual(adapter.count('selectedSectionDuration('), 3)


@unittest.skipUnless(engine.CLI.is_file(), 'Real Swift QualityCLI absent; do not substitute a mock planner')
class IntactCLIIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.cancel = threading.Event()
        self.sources = [clip(50, 'first.mov'), clip(55, 'second.mov')]
        self.settings = engine.settings_from({'targetSeconds': 30, 'preserveSections': True})

    def tearDown(self):
        self.tmp.cleanup()

    def direct(self, **args):
        return engine.direct(self.root, self.sources, self.settings, self.cancel, **args)

    def test_first_plan_is_complete_ordered_and_not_target_fitted(self):
        for transition in ('automatic', 'dissolves', 'cuts'):
            self.settings['transitions'] = transition
            result = self.direct()
            moments = result['plan']['moments']
            self.assertEqual([m['clipID'] for m in moments], [c['id'] for c in self.sources])
            self.assertEqual([m['start'] for m in moments], [0, 0])
            self.assertEqual([m['duration'] for m in moments], [50, 55])
            self.assertTrue(all(m['locked'] for m in moments))
            self.assertEqual([s['at'] for s in result['timeline']], [0, 50])
            self.assertTrue(all(s['overlap'] == 0 for s in result['timeline']))
            self.assertTrue(any('Requested 30s' in w and '105.0s' in w for w in result['plan']['warnings']))
            self.assertTrue(result['plan']['settings']['preserveSections'])

    def test_regeneration_keeps_selected_ranges_order_locks_and_rejections(self):
        chosen = [moment(self.sources[1], 9, 35), moment(self.sources[0], 3, 27, locked=False),
                  moment(self.sources[1], 1, 2, approved=False)]
        previous = dict(version=1, settings=self.settings, moments=chosen, warnings=[], director='Selected')
        self.settings['prompt'] = '15 seconds, hype, cuts only'
        result = self.direct(previous=previous, seed=99)
        self.assertEqual(result['plan']['moments'], chosen)
        self.assertEqual([s['at'] for s in result['timeline']], [0, 35])
        checked = self.direct(plan=result['plan'])
        self.assertEqual(checked['timeline'], result['timeline'])

    def test_single_upload_and_empty_rejected_selection(self):
        self.sources = self.sources[:1]
        self.assertEqual(self.direct()['plan']['moments'][0]['duration'], 50)
        previous = self.direct()['plan']
        previous['moments'][0]['approved'] = False
        with self.assertRaises(engine.TestError):
            self.direct(previous=previous)

    def test_exact_limit_passes_over_limit_requests_a_real_choice(self):
        self.sources = [clip(150, 'a.mov'), clip(150, 'b.mov')]
        result = self.direct()
        self.assertEqual(result['timeline'][-1]['at'] + result['timeline'][-1]['moment']['duration'], 300)
        self.sources[-1]['duration'] = 150.001
        with self.assertRaisesRegex(engine.TestError, 'clear this test and upload fewer/shorter clips'):
            self.direct()
        result['plan']['moments'][-1]['duration'] = 150.001
        with self.assertRaisesRegex(engine.TestError, '300.001s.*Reject a section or unlock and trim'):
            self.direct(plan=result['plan'])

    def test_exact_limit_compensates_seventeen_selected_ranges(self):
        self.sources = [clip(300, 'full.mov')]
        durations = [300/17]*17
        selected = [moment(self.sources[0], i*durations[0], d) for i,d in enumerate(durations)]
        previous = dict(version=1, settings=self.settings, moments=selected, warnings=[], director='Selected')
        # Builtin sum uses compensated addition on newer Python versions.
        # Model the OLD adapter's sequential reduce explicitly instead.
        sequential = 0.0
        for duration in durations:
            sequential += duration
        self.assertGreater(sequential, 300)
        self.assertEqual(math.fsum(durations), 300)
        result = self.direct(previous=previous)
        self.assertEqual(result['plan']['moments'], selected)
        checked = self.direct(plan=result['plan'])
        self.assertEqual(checked['plan']['moments'], selected)
        _, sampled = engine.intact_frame_timeline(checked['timeline'])
        self.assertEqual(engine.validate_intact_duration(checked['timeline'], sampled), 300)

    def test_core_rejects_bad_range_and_duplicate_moment_ids(self):
        previous = self.direct()['plan']
        previous['moments'][0]['duration'] = 51
        with self.assertRaises(engine.TestError):
            self.direct(previous=previous)
        previous = self.direct()['plan']
        previous['moments'][1]['id'] = previous['moments'][0]['id']
        with self.assertRaises(engine.TestError):
            self.direct(previous=previous)

    def test_default_thirty_second_highlight_still_uses_existing_planner(self):
        self.settings = engine.settings_from({'targetSeconds': 30, 'transitions': 'cuts'})
        result = self.direct()
        self.assertFalse(result['plan']['settings']['preserveSections'])
        self.assertGreater(len(result['plan']['moments']), 2)
        self.assertAlmostEqual(result['timeline'][-1]['at'] + result['timeline'][-1]['moment']['duration'], 30, delta=.08)


class IntactRendererTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory(prefix='compass-intact-generated-')
        cls.fixtures = Path(cls.tmp.name)
        cls.paths = []
        for index, tone in enumerate((440, 880, 1320)):
            path = cls.fixtures/f'generated-{index}.mov'
            color = ('red', 'blue', 'green')[index]
            engine.ff(['-f', 'lavfi', '-i', f'color={color}:s=160x90:r=30:d=3',
                       '-f', 'lavfi', '-i', f'sine=frequency={tone}:sample_rate=48000:duration=3',
                       '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'pcm_s16le', str(path)])
            cls.paths.append(path)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=self.fixtures)
        self.root = Path(self.tmp.name)
        self.cancel = threading.Event()
        self.sources = []
        for path in self.paths:
            shutil.copyfile(path, self.root/path.name)
            self.sources.append(clip(3, path.name))
        self.lengths = [1.013, 1.019, 1.011]
        self.moments = [moment(c, .2, length) for c, length in zip(self.sources, self.lengths)]
        cursor = 0
        self.timeline = []
        for m in self.moments:
            self.timeline.append(dict(at=cursor, overlap=0, incoming='cut', moment=m))
            # Match the core's 1/600-second cursor, separate from exact PCM.
            cursor = math.floor((cursor + m['duration'])*600+.5)/600
        self.settings = engine.settings_from({'preserveSections': True, 'targetSeconds': 30})
        self.directed = dict(plan=dict(settings=self.settings, moments=self.moments), timeline=self.timeline)

    def tearDown(self):
        self.tmp.cleanup()

    def test_pcm_sections_keep_every_sample_without_mixing_and_ramps_are_bounded(self):
        output = engine.intact_audio(self.root, self.sources, self.timeline, self.cancel,
                                     engine.AudioPolicy(), engine.render_deadline(4))
        with wave.open(str(output), 'rb') as pcm:
            actual = pcm.readframes(pcm.getnframes())
        self.assertEqual(len(actual), sum(round(n*48000) for n in self.lengths)*4)
        offset = 0
        for index, (m, source) in enumerate(zip(self.moments, self.sources)):
            n = round(m['duration']*48000)
            raw = engine.ff(['-ss', '0.2']+engine.inp(self.root/source['fileName'])+
                            ['-vn', '-af', f'atrim=end_sample={n}', '-ar', '48000', '-ac', '2', '-f', 's16le', 'pipe:1'])
            first = 240 if index else 0
            last = n-240 if index+1 < len(self.sources) else n
            self.assertEqual(actual[offset+first*4:offset+last*4], raw[first*4:last*4])
            offset += n*4

    def test_final_aac_duration_fades_and_section_order(self):
        profile = dict(name='generated 160x90', width=160, height=90, crf=18)
        with patch.object(engine, 'output_profile', return_value=profile):
            output = engine.render(self.root, self.sources, self.directed, self.cancel, lambda *_: None, preview=True)
        info = engine.probe(output)
        audio = next(s for s in info['streams'] if s['codec_type']=='audio')
        video = next(s for s in info['streams'] if s['codec_type']=='video')
        total = sum(self.lengths)
        self.assertAlmostEqual(engine.stream_seconds(audio,'duration'),total,delta=1024/48000+.002)
        self.assertGreaterEqual(engine.stream_seconds(video,'duration')+1e-8,total)
        self.assertLess(engine.stream_seconds(video,'duration')-total,1/30+.001)
        cursor = 0
        for index, length in enumerate(self.lengths):
            t = cursor + .3
            raw = engine.ff(['-ss', str(t)]+engine.inp(output)+['-t', '0.2','-vn','-ar','48000','-ac','1','-f','f32le','pipe:1'])
            values = array.array('f'); values.frombytes(raw)
            frequency = sum(a <= 0 < b for a,b in zip(values,values[1:]))/(len(values)/48000)
            self.assertAlmostEqual(frequency,(440,880,1320)[index],delta=7)
            cursor += length
        # At the first incoming frame the second video is black, not a blend.
        frames = engine.ff(engine.inp(output)+['-vf','scale=1:1','-an','-pix_fmt','rgb24','-f','rawvideo','pipe:1'])
        self.assertLess(max(frames[30*3:31*3]), 5)
        self.assertLess(max(frames[29*3:30*3]), 80)
        self.assertLess(max(frames[31*3:32*3]), 80)
        self.assertTrue(all((self.root/c['fileName']).exists() for c in self.sources))
        self.assertFalse(list(self.root.glob('section-audio-*.*')))

    def test_shared_video_origin_and_original_leading_gap_are_preserved(self):
        path = self.root/'offset.mov'
        pulse = 'if(between(t\\,0.25\\,0.35)\\,0.8*sin(2*PI*1000*t)\\,0)'
        engine.ff(['-itsoffset', '0.3', '-f', 'lavfi', '-i', 'color=black:s=160x90:r=30:d=2',
                   '-itsoffset', '0.55', '-f', 'lavfi', '-i', f'aevalsrc={pulse}:s=48000:d=2',
                   '-c:v', 'libx264', '-preset', 'ultrafast', '-fps_mode', 'passthrough',
                   '-c:a', 'pcm_s16le', str(path)])
        timing = engine.source_timing(engine.probe(path))
        self.assertAlmostEqual(timing['videoStart'], .3, places=6)
        self.assertEqual(int(timing['video']['nb_frames']), 60)
        source = clip(2, path.name)
        selected = [moment(source, 0, 1.013), moment(source, .3, 1.019)]
        timeline = [dict(at=0, overlap=0, incoming='cut', moment=selected[0]),
                    dict(at=1.013, overlap=0, incoming='cut', moment=selected[1])]
        output = engine.intact_audio(self.root, [source], timeline, self.cancel,
                                     engine.AudioPolicy(), engine.render_deadline(3))
        with wave.open(str(output), 'rb') as pcm:
            content = pcm.readframes(pcm.getnframes())
        values = array.array('h'); values.frombytes(content); mono = values[::2]
        first = next(i/48000 for i,x in enumerate(mono) if abs(x)>1000)
        n = round(1.013*48000)
        second = next(i/48000 for i,x in enumerate(mono[n:]) if abs(x)>1000)
        self.assertAlmostEqual(first, .5, delta=1/48000+1e-9)
        self.assertAlmostEqual(second, .2, delta=1/48000+1e-9)
        self.assertLess(max(abs(x) for x in mono[:int(.25*48000)]), 2)

    def test_mute_is_preserved_without_shrinking_the_section(self):
        self.moments[1]['muted'] = True
        output = engine.intact_audio(self.root, self.sources, self.timeline, self.cancel,
                                     engine.AudioPolicy(), engine.render_deadline(4))
        with wave.open(str(output), 'rb') as pcm:
            content = pcm.readframes(pcm.getnframes())
        start, end = round(self.lengths[0]*48000)*4, sum(round(n*48000) for n in self.lengths[:2])*4
        self.assertEqual(content[start:end], bytes(end-start))
        self.assertEqual(len(content), sum(round(n*48000) for n in self.lengths)*4)

    def test_continuous_source_must_cover_actual_intact_duration(self):
        self.directed['wizard'] = dict(audioMode='single-source', audioClipID=self.sources[0]['id'], audioStart=0)
        with patch.object(engine, 'assemble_bounded', side_effect=AssertionError('Reject before pictures')):
            with self.assertRaisesRegex(engine.TestError, 'not fully covered'):
                engine.render(self.root, self.sources, self.directed, self.cancel, lambda *_: None, preview=True)

    def test_failed_intact_soundtrack_cleans_partials_and_keeps_originals(self):
        def interrupted(*args):
            (self.root/'section-audio-final.wav').write_bytes(b'generated partial')
            raise engine.TestError('Generated interruption')
        profile = dict(name='generated 160x90', width=160, height=90, crf=18)
        with patch.object(engine, 'output_profile', return_value=profile), patch.object(engine, 'intact_audio', side_effect=interrupted):
            with self.assertRaisesRegex(engine.TestError, 'Generated interruption'):
                engine.render(self.root, self.sources, self.directed, self.cancel, lambda *_: None, preview=True)
        self.assertTrue(all((self.root/c['fileName']).exists() for c in self.sources))
        self.assertFalse((self.root/'preview.mp4').exists())
        for pattern in ('section-audio-*.*', 'segment-*.*', 'piece-*.*', 'pending.mp4', 'master-pending.mp4'):
            self.assertFalse(list(self.root.glob(pattern)), pattern)

    def test_overlapping_timeline_is_rejected_before_media_work(self):
        self.directed['timeline'][1]['overlap'] = .1
        with patch.object(engine, 'probe', side_effect=AssertionError('No media work')):
            with self.assertRaisesRegex(engine.TestError, 'without overlaps'):
                engine.render(self.root, self.sources, self.directed, self.cancel, lambda *_: None, preview=True)


if __name__ == '__main__':
    unittest.main(verbosity=2)
