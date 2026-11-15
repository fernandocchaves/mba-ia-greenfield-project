import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { InvalidMediaError } from './media.errors';
import { MediaProbeService } from './media-probe.service';

const execFileAsync = promisify(execFile);

describe('MediaProbeService (integration — real FFmpeg)', () => {
  const service = new MediaProbeService();
  let dir: string;
  let clip: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'probe-it-'));
    clip = join(dir, 'clip.mp4');
    // 2 s, 320x240, 25 fps test pattern with a sine tone.
    await execFileAsync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=320x240:rate=25',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=2',
      '-shortest',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      clip,
    ]);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('probes duration and metadata of a real clip', async () => {
    const result = await service.probe(clip);

    expect(result.durationSeconds).toBeCloseTo(2, 0);
    expect(result.metadata).toMatchObject({
      width: 320,
      height: 240,
      videoCodec: 'h264',
      audioCodec: 'aac',
      frameRate: 25,
    });
  });

  it('extracts a JPEG thumbnail', async () => {
    const out = join(dir, 'thumb.jpg');

    await service.extractThumbnail(clip, 0.2, out);

    const jpeg = await readFile(out);
    expect(jpeg.length).toBeGreaterThan(100);
    expect(jpeg.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
  });

  it('rejects a file that is not a video', async () => {
    const bogus = join(dir, 'bogus.mp4');
    await writeFile(bogus, 'definitely not a video');

    await expect(service.probe(bogus)).rejects.toBeInstanceOf(
      InvalidMediaError,
    );
  });
});
