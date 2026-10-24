#!/usr/bin/env python3
"""Generate synthetic codec fixtures and an unsigned-alpha placeholder icon.

Never reads Photos, contacts a media service, or includes real concert footage.
FFmpeg is a developer/CI dependency only; the iPhone app uses AVFoundation.
"""
from pathlib import Path
import json
import math
import shutil
import struct
import subprocess
import zlib

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / 'iOS/ConcertCompassTests/Fixtures'
ASSETS = ROOT / 'iOS/ConcertCompass/Assets.xcassets'


def fixture(name, size, *, audio=True, hevc=False):
    target = FIXTURES / name
    if target.exists():
        return
    cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y',
           '-f', 'lavfi', '-i', f'testsrc2=size={size}:rate=30:duration=4']
    if audio:
        cmd += ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4']
    cmd += ['-map', '0:v:0']
    if audio:
        cmd += ['-map', '1:a:0', '-c:a', 'aac', '-b:a', '128k', '-ac', '2']
    else:
        cmd += ['-an']
    cmd += ['-c:v', 'libx265' if hevc else 'libx264', '-threads', '2',
            '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le' if hevc else 'yuv420p']
    if hevc:
        cmd += ['-x265-params', 'pools=1:frame-threads=1:log-level=error', '-tag:v', 'hvc1']
    cmd += ['-t', '4', '-movflags', '+faststart', str(target)]
    subprocess.run(cmd, check=True, timeout=120)
    metadata = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_streams',
                        '-of', 'json', str(target)], check=True, capture_output=True).stdout)
    video = next(s for s in metadata['streams'] if s['codec_type'] == 'video')
    assert video['codec_name'] == ('hevc' if hevc else 'h264'), metadata
    assert any(s['codec_type'] == 'audio' for s in metadata['streams']) == audio
    if hevc:
        assert video['pix_fmt'] == 'yuv420p10le', metadata
    print(f'Generated synthetic fixture: {name}', flush=True)


def placeholder_icon():
    icon = ASSETS / 'AppIcon.appiconset'
    icon.mkdir(parents=True, exist_ok=True)
    (ASSETS / 'Contents.json').write_text(json.dumps({'info': {'author': 'xcode', 'version': 1}}))
    (icon / 'Contents.json').write_text(json.dumps({'images': [
        {'filename': 'AppIcon.png', 'idiom': 'universal', 'platform': 'ios', 'size': '1024x1024'}
    ], 'info': {'author': 'xcode', 'version': 1}}))
    # Do not replace the original checkpoint's icon when it is already present.
    if (icon / 'AppIcon.png').exists():
        return
    size = 1024
    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            dx, dy = x - 511.5, y - 511.5
            radius = math.hypot(dx, dy)
            ring = 300 < radius < 330
            needle = abs(dx) < 115 * (1 - abs(dy) / 240) and abs(dy) < 240
            color = (192, 135, 255) if ring else ((239, 225, 255) if dy < 0 else (135, 79, 220)) if needle else (16, 12, 29)
            rows.extend(color)
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 2, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(bytes(rows), 9)) + chunk(b'IEND', b'')
    (icon / 'AppIcon.png').write_bytes(png)


def main():
    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        raise SystemExit('FFmpeg/ffprobe are needed to generate synthetic test fixtures.')
    FIXTURES.mkdir(parents=True, exist_ok=True)
    fixture('portrait_h264.mp4', '320x568')
    fixture('landscape_h264.mp4', '568x320')
    fixture('silent_h264.mp4', '320x568', audio=False)
    fixture('portrait_hevc.mov', '320x568', hevc=True)
    placeholder_icon()

if __name__ == '__main__':
    main()
