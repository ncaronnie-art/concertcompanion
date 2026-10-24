"""Synthetic multi-song audio, never personal footage or a listening claim."""
import array
import copy
import math
import shutil
import sys
import tempfile
import threading
import unittest
import wave
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import engine
from devtest.tests.test_intact_sections import clip, moment

PROFILE = dict(name='synthetic 160x90', width=160, height=90, crf=18)


def integers(data):
    values = array.array('h', data)
    if sys.byteorder != 'little':
        values.byteswap()
    return values


class SongTransitionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='compass-synthetic-song-joins-')
        cls.fixtures = Path(cls.temp.name)
        cls.paths = []
        # Different pitches, voice-like modulation/harmonics, unequal levels,
        # and different stereo channels make accidental mixing detectable.
        for index, (hz, level) in enumerate(((220, .72), (523, .24), (349, .48))):
            path = cls.fixtures / f'synthetic-song-{index}.mov'
            voice = f'{level}*(0.8+0.2*sin(2*PI*3*t))*(0.8*sin(2*PI*{hz}*t)+0.2*sin(2*PI*{hz*2}*t))'
            engine.ff(['-f', 'lavfi', '-i', f'color={("red", "blue", "green")[index]}:s=160x90:r=30:d=3',
                       '-f', 'lavfi', '-i', f'aevalsrc={voice}|0.6*({voice}):s=48000:d=3',
                       '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'pcm_s16le', str(path)])
            cls.paths.append(path)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=self.fixtures)
        self.root = Path(self.temp.name)
        self.cancel = threading.Event()
        self.sources = []
        for path in self.paths:
            shutil.copyfile(path, self.root / path.name)
            self.sources.append(clip(3, path.name))
        self.make_plan([2.013, 2.019, 2.011])

    def tearDown(self):
        self.temp.cleanup()

    def make_plan(self, lengths):
        self.moments = [moment(c, .2, length) for c, length in zip(self.sources, lengths)]
        self.timeline = []
        cursor = 0
        for m in self.moments:
            self.timeline.append(dict(at=cursor, overlap=0, incoming='cut', moment=m))
            cursor = round((cursor+m['duration'])*600)/600
        self.settings = engine.settings_from({'preserveSections': True, 'transitions': 'automatic'})
        self.directed = dict(plan=dict(settings=self.settings, moments=self.moments), timeline=self.timeline)

    def soundtrack(self, settings=None):
        output = engine.intact_audio(self.root, self.sources, self.timeline, self.cancel,
                                    engine.AudioPolicy.from_settings(settings or self.settings),
                                    engine.render_deadline(8))
        with wave.open(str(output), 'rb') as pcm:
            self.assertEqual((pcm.getframerate(), pcm.getnchannels(), pcm.getsampwidth()), (48000, 2, 2))
            return pcm.readframes(pcm.getnframes())

    def raw_section(self, index):
        m = self.moments[index]
        n = round(m['duration']*48000)
        return engine.ff(['-ss', str(m['start'])] + engine.inp(self.root/self.sources[index]['fileName']) +
                         ['-vn', '-af', f'atrim=end_sample={n}', '-ar', '48000', '-ac', '2', '-f', 's16le', 'pipe:1'])

    def assert_bounded_gains(self, content, soft=True):
        self.assertEqual(len(content), sum(round(m['duration']*48000) for m in self.moments)*4)
        offset = 0
        for index, m in enumerate(self.moments):
            raw = self.raw_section(index)
            n = round(m['duration']*48000)
            section = content[offset:offset+n*4]
            ramp = min(7200 if soft else 240, n//4)
            left = ramp if index else 0
            right = n-ramp if index+1 < len(self.moments) else n
            # Exact equality also verifies source order, levels, timing and
            # stereo layout, including untouched first/last outer edges.
            self.assertEqual(section[left*4:right*4], raw[left*4:right*4])
            actual, original = integers(section), integers(raw)
            for frame in list(range(left)) + list(range(right, n)):
                fraction = frame/ramp if frame < left else (n-frame)/ramp
                gain = .5-.5*math.cos(math.pi*fraction) if soft else fraction
                for channel in (0, 1):
                    a, b = actual[frame*2+channel], original[frame*2+channel]
                    self.assertLessEqual(abs(a), abs(b)+1)  # Never boost peaks.
                    self.assertAlmostEqual(a, b*gain, delta=2)  # No other song mixed in.
            self.assertLess(max(abs(v) for v in actual), 32767)
            offset += n*4

    def test_soft_joins_preserve_every_interior_sample_order_and_unequal_levels(self):
        before = copy.deepcopy(self.directed)
        self.assert_bounded_gains(self.soundtrack())
        self.assertEqual(self.directed, before)

    def test_cuts_keep_exact_legacy_declick_and_do_not_enable_song_fades(self):
        cuts = {**self.settings, 'transitions': 'cuts'}
        self.assert_bounded_gains(self.soundtrack(cuts), soft=False)
        for settings in ({}, {'preserveSections': False, 'transitions': 'dissolves'},
                         {'preserveSections': True, 'transitions': 'unknown'}):
            self.assertFalse(engine.AudioPolicy.from_settings(settings).intact_soft_fades)

    def test_short_sections_keep_at_least_half_unchanged_and_outer_edges_untouched(self):
        self.make_plan([.04, .061, .099])
        self.assert_bounded_gains(self.soundtrack())
        self.make_plan([.15])
        self.assertEqual(self.soundtrack(), self.raw_section(0))
        self.assertEqual(engine.intact_audio_transition(self.directed)['mode'], 'single-section')

    def test_muted_section_stays_silent_without_shrinking_or_boosting_neighbors(self):
        self.moments[1]['muted'] = True
        content = self.soundtrack()
        sizes = [round(m['duration']*48000)*4 for m in self.moments]
        self.assertEqual(len(content), sum(sizes))
        self.assertEqual(content[sizes[0]:sum(sizes[:2])], bytes(sizes[1]))
        self.assertEqual(content[:sizes[0]-7200*4], self.raw_section(0)[:-7200*4])
        self.assertEqual(content[sum(sizes[:2])+7200*4:], self.raw_section(2)[7200*4:])

    def test_rendered_aac_has_no_clipping_and_export_is_exact_reviewed_preview(self):
        with patch.object(engine, 'output_profile', return_value=PROFILE):
            preview = engine.render(self.root, self.sources, self.directed, self.cancel, lambda *_: None, preview=True)
        reviewed = preview.read_bytes()
        for source, fixture in zip(self.sources, self.paths):
            self.assertEqual((self.root/source['fileName']).read_bytes(), fixture.read_bytes())
        values = array.array('f', engine.ff(engine.inp(preview) + ['-vn', '-f', 'f32le', 'pipe:1']))
        if sys.byteorder != 'little':
            values.byteswap()
        self.assertLess(max(abs(v) for v in values), 1)
        audio = next(s for s in engine.probe(preview)['streams'] if s['codec_type'] == 'audio')
        expected = sum(round(m['duration']*48000) for m in self.moments)/48000
        self.assertAlmostEqual(engine.stream_seconds(audio, 'duration'), expected, delta=1/48000+.001)
        final = engine.finalize_preview(self.root)
        self.assertEqual(final.read_bytes(), reviewed)
        self.assertFalse(any((self.root/c['fileName']).exists() for c in self.sources))

    def test_continuous_bed_is_identical_across_intact_transition_choices(self):
        self.make_plan([.6, .7, .8])
        self.directed['wizard'] = dict(audioMode='single-source', audioClipID=self.sources[0]['id'], audioStart=.2)
        decoded = []
        for transition in ('cuts', 'automatic', 'dissolves'):
            self.settings['transitions'] = transition
            with patch.object(engine, 'output_profile', return_value=PROFILE), \
                 patch.object(engine, 'intact_audio', side_effect=AssertionError('Continuous bed must bypass joins')):
                output = engine.render(self.root, self.sources, self.directed, self.cancel, lambda *_: None, preview=True)
            decoded.append(engine.ff(engine.inp(output) + ['-vn', '-f', 's16le', 'pipe:1']))
            self.assertEqual(engine.intact_audio_transition(self.directed)['mode'], 'continuous-source')
        self.assertEqual(decoded[0], decoded[1])
        self.assertEqual(decoded[1], decoded[2])

    def test_cancel_during_real_song_decode_keeps_sources_and_removes_partials(self):
        original_ff = engine.ff
        reached = []
        def cancel_after_section(args, *rest):
            result = original_ff(args, *rest)
            if str(args[-1]).endswith('section-audio-000.pcm'):
                reached.append(True)
                self.cancel.set()
            return result
        with patch.object(engine, 'output_profile', return_value=PROFILE), patch.object(engine, 'ff', side_effect=cancel_after_section):
            with self.assertRaisesRegex(engine.TestError, 'Stopped safely'):
                engine.render(self.root, self.sources, self.directed, self.cancel, lambda *_: None, preview=True)
        self.assertEqual(reached, [True])
        for source, fixture in zip(self.sources, self.paths):
            self.assertEqual((self.root/source['fileName']).read_bytes(), fixture.read_bytes())
        self.assertFalse((self.root/'preview.mp4').exists())
        for pattern in ('section-audio-*', 'segment-*', 'piece-*', 'pending.mp4', 'master-pending.mp4'):
            self.assertFalse(list(self.root.glob(pattern)))


if __name__ == '__main__':
    unittest.main(verbosity=2)
