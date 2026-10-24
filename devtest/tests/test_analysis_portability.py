"""Generated HDR fixtures and owned-process cleanup; no user media or services."""
import hashlib
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import engine


class ProcessCleanupTests(unittest.TestCase):
    def run_owned_child(self, platform, cancel=False):
        processes = []
        popen = subprocess.Popen
        event = threading.Event()

        def launch(*args, **kwargs):
            self.assertEqual(kwargs['start_new_session'], platform == 'posix')
            self.assertNotIn('COMPASS_TEST_SECRET', kwargs['env'])
            child = popen(*args, **kwargs)
            processes.append(child)
            if cancel:
                event.set()
            return child

        # Exercise the Windows handle-kill branch with a REAL owned child on
        # this host. This is not a claim of Windows kernel/device validation.
        host = SimpleNamespace(name=platform, environ={**os.environ, 'COMPASS_TEST_SECRET': 'synthetic'},
                               killpg=Mock(side_effect=os.killpg) if hasattr(os, 'killpg') else Mock())
        before = time.monotonic()
        with patch.object(engine, 'os', host), patch.object(engine.subprocess, 'Popen', side_effect=launch):
            with self.assertRaisesRegex(engine.TestError, 'Stopped safely' if cancel else 'too long'):
                engine.run([sys.executable, '-c', 'import time; time.sleep(20)'], event,
                           timeout=5 if cancel else .05)
        self.assertLess(time.monotonic() - before, 5)
        self.assertEqual(len(processes), 1)
        self.assertIsNotNone(processes[0].poll())
        self.assertTrue(processes[0].stdout.closed)
        self.assertTrue(processes[0].stderr.closed)
        self.assertEqual(host.killpg.call_count, int(platform == 'posix'))

    @unittest.skipUnless(os.name == 'posix', 'POSIX process groups require a POSIX host')
    def test_posix_timeout_reaps_owned_group(self):
        self.run_owned_child('posix')

    @unittest.skipUnless(os.name == 'posix', 'POSIX process groups require a POSIX host')
    def test_posix_cancellation_reaps_owned_group(self):
        self.run_owned_child('posix', cancel=True)

    def test_windows_branch_timeout_reaps_owned_process_without_killpg(self):
        self.run_owned_child('nt')

    def test_windows_branch_cancellation_reaps_owned_process_without_killpg(self):
        self.run_owned_child('nt', cancel=True)

    def test_exit_race_preserves_original_timeout_and_reaps(self):
        child = Mock(pid=987654, returncode=None)
        child.poll.return_value = None
        child.communicate.return_value = (b'', b'')
        host = SimpleNamespace(name='posix', environ={}, killpg=Mock(side_effect=ProcessLookupError))
        with patch.object(engine, 'os', host), patch.object(engine.subprocess, 'Popen', return_value=child):
            with self.assertRaisesRegex(engine.TestError, 'too long'):
                engine.run(['ffmpeg'], timeout=-1)
        child.communicate.assert_called_once_with()

    def test_windows_runtime_environment_is_allowlisted_not_inherited(self):
        child = Mock(returncode=0)
        child.communicate.return_value = (b'ok', b'')
        child.poll.return_value = 0
        allowed = {'PATH': 'test-bin', 'SYSTEMROOT': 'test-system', 'WINDIR': 'test-windows',
                   'TEMP': 'test-temp', 'TMP': 'test-tmp'}
        host = SimpleNamespace(name='nt', environ={**allowed, 'GITHUB_TOKEN': 'synthetic-secret'})
        with patch.object(engine, 'os', host), patch.object(engine.subprocess, 'Popen', return_value=child) as launch:
            self.assertEqual(engine.run(['ffmpeg']), b'ok')
        self.assertEqual(launch.call_args.kwargs['env'], allowed)
        child.kill.assert_not_called()

    def test_normal_output_and_error_contract_still_work(self):
        self.assertEqual(engine.run([sys.executable, '-c', 'print("synthetic")']).strip(), b'synthetic')
        with self.assertRaisesRegex(engine.TestError, 'Media processing failed') as failed:
            engine.run([sys.executable, '-c', 'import sys; sys.stderr.write("generated failure"); sys.exit(1)'])
        self.assertIn('generated failure', failed.exception.diagnostic)

    def test_cancel_during_successful_communicate_is_not_reported_as_success(self):
        event = threading.Event()
        child = Mock(returncode=0)
        child.poll.return_value = 0

        def completed(**kwargs):
            self.assertEqual(kwargs['timeout'], .2)
            event.set()  # Cancellation arrives inside the final wait window.
            return b'finished', b''

        child.communicate.side_effect = completed
        with patch.object(engine.subprocess, 'Popen', return_value=child):
            with self.assertRaisesRegex(engine.TestError, 'Stopped safely'):
                engine.run(['ffmpeg'], event)
        child.kill.assert_not_called()  # Already exited: never kill a reused PID.

    def test_real_short_child_cancelled_inside_communicate_window(self):
        event = threading.Event()
        processes, timers = [], []
        popen = subprocess.Popen

        def launch(*args, **kwargs):
            child = popen(*args, **kwargs)
            processes.append(child)
            communicate = child.communicate

            def waiting(*args, **kwargs):
                if not timers:
                    timer = threading.Timer(.025, event.set)
                    timers.append(timer)
                    timer.start()
                return communicate(*args, **kwargs)

            child.communicate = waiting
            return child

        try:
            with patch.object(engine.subprocess, 'Popen', side_effect=launch):
                with self.assertRaisesRegex(engine.TestError, 'Stopped safely'):
                    engine.run([sys.executable, '-c', 'import time; time.sleep(.08); print("finished")'], event)
        finally:
            for timer in timers:
                timer.join()
        self.assertTrue(event.is_set())
        self.assertEqual(len(processes), 1)
        self.assertIsNotNone(processes[0].poll())
        self.assertTrue(processes[0].stdout.closed)
        self.assertTrue(processes[0].stderr.closed)


class HDRAnalysisTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workspace = tempfile.TemporaryDirectory(prefix='compass-generated-hdr-analysis-')
        cls.root = Path(cls.workspace.name)
        cls.paths = {}
        for transfer in ('smpte2084', 'arib-std-b67'):
            source = cls.root / (transfer + '-landscape.mov')
            path = cls.root / (transfer + '.mov')
            engine.ff(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=3.1',
                       '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3.1',
                       '-c:v', 'libx265', '-preset', 'ultrafast', '-threads', '2',
                       '-x265-params', 'pools=1:frame-threads=1:log-level=error:colorprim=9:colormatrix=9:transfer=' +
                       ('16' if transfer == 'smpte2084' else '18'),
                       '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1', '-color_primaries', 'bt2020',
                       '-color_trc', transfer, '-colorspace', 'bt2020nc', '-c:a', 'aac', '-ac', '2', str(source)])
            engine.ff(['-display_rotation:v:0', '90'] + engine.inp(source) +
                      ['-map', '0', '-c', 'copy', str(path)])
            cls.paths[transfer] = path

    @classmethod
    def tearDownClass(cls):
        cls.workspace.cleanup()

    def measured_frames(self, path, filters):
        start = time.monotonic()
        raw = engine.ff(['-ss', '0'] + engine.inp(path) +
                        ['-t', '3.1', '-vf', filters, '-an', '-f', 'rawvideo', 'pipe:1'])
        return raw, time.monotonic() - start

    def test_hdr_pq_and_hlg_keep_exact_samples_and_rotation(self):
        for transfer, path in self.paths.items():
            with self.subTest(transfer=transfer):
                video = engine.probe(path)['streams'][0]
                self.assertEqual(video['color_transfer'], transfer)
                self.assertEqual(abs(video['side_data_list'][0]['rotation']), 90)
                old = engine.color_filter(video) + 'fps=1:start_time=0,scale=64:64,format=gray'
                before, old_time = self.measured_frames(path, old)
                after, new_time = self.measured_frames(path, engine.visual_analysis_filter(video))
                self.assertEqual(after, before)
                self.assertEqual(len(after), 3 * 4096)
                self.assertGreater(len(set(after)), 20)
                self.assertNotEqual(after[:4096], after[4096:8192])
                print(f'Generated {transfer} 1080p rotated 3.1s: legacy={old_time:.3f}s sampled-first={new_time:.3f}s; exact {len(after)} bytes', flush=True)

    def test_sdr_filter_and_analysis_budget_are_unchanged(self):
        self.assertEqual(engine.visual_analysis_filter({}), 'fps=1:start_time=0,scale=64:64,format=gray')
        self.assertEqual(engine.MAX_CLIP_SECONDS, 300)

    def test_actual_analysis_retains_source_audio_and_measurement_timestamps(self):
        path = self.paths['arib-std-b67']
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        metadata = engine.analyze(path, 1, threading.Event(), make_preview=False)
        self.assertFalse(path.with_suffix('.preview.mp4').exists())
        self.assertFalse(path.with_suffix('.poster.jpg').exists())
        started = time.monotonic()
        clip = engine.analyze(path, 1, threading.Event())
        elapsed = time.monotonic() - started
        self.assertEqual((clip['width'], clip['height']), (1080, 1920))
        self.assertEqual(clip['duration'], 3.1)
        self.assertEqual([v['time'] for v in clip['visual']], [0, 1, 2])
        self.assertGreater(len(clip['audio']), 20)
        self.assertTrue(clip['hasAudio'])
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), digest)
        preview = engine.probe(path.with_suffix('.preview.mp4'))
        video = preview['streams'][0]
        self.assertEqual((video['width'], video['height']), (540, 960))
        self.assertAlmostEqual(float(preview['format']['duration']), 3.1, delta=.04)
        self.assertTrue(path.with_suffix('.poster.jpg').is_file())
        self.assertEqual(clip, metadata)
        print(f'Generated HLG 1080p rotated 3.1s full analyze (audio/visual/proxy/poster): {elapsed:.3f}s', flush=True)

    def test_cancelled_analysis_keeps_source_and_does_not_create_proxy(self):
        path = self.paths['smpte2084']
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        event = threading.Event()
        event.set()
        with self.assertRaisesRegex(engine.TestError, 'Stopped safely'):
            engine.analyze(path, 1, event, make_preview=False)
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), digest)
        self.assertFalse(path.with_suffix('.preview.mp4').exists())
        self.assertFalse(path.with_suffix('.poster.jpg').exists())

    def test_cancel_during_final_visual_communicate_cannot_return_analysis(self):
        path = self.paths['smpte2084']
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        event = threading.Event()
        popen = subprocess.Popen
        measured = []

        def launch(args, **kwargs):
            child = popen(args, **kwargs)
            if 'rawvideo' in args:
                communicate = child.communicate

                def completed(*args, **kwargs):
                    result = communicate(*args, **kwargs)
                    measured.append(len(result[0]))
                    event.set()  # Real visual subprocess completed in this wait.
                    return result

                child.communicate = completed
            return child

        with patch.object(engine.subprocess, 'Popen', side_effect=launch):
            with self.assertRaisesRegex(engine.TestError, 'Stopped safely'):
                engine.analyze(path, 1, event, make_preview=False)
        self.assertEqual(measured, [3 * 4096])
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), digest)
        self.assertFalse(path.with_suffix('.preview.mp4').exists())
        self.assertFalse(path.with_suffix('.poster.jpg').exists())

    def test_cancel_after_final_visual_measurement_cannot_return_analysis(self):
        path = self.paths['smpte2084']
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        event = threading.Event()
        ff = engine.ff
        measured = []

        def finish(args, *rest):
            raw = ff(args, *rest)
            if 'rawvideo' in args:
                measured.append(len(raw))
                event.set()  # After run's guard, before Python computes the record.
            return raw

        with patch.object(engine, 'ff', side_effect=finish):
            with self.assertRaisesRegex(engine.TestError, 'Stopped safely'):
                engine.analyze(path, 1, event, make_preview=False)
        self.assertEqual(measured, [3 * 4096])
        self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), digest)
        self.assertFalse(path.with_suffix('.preview.mp4').exists())
        self.assertFalse(path.with_suffix('.poster.jpg').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
