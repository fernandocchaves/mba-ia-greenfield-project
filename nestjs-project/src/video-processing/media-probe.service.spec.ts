import { InvalidMediaError } from './media.errors';
import { parseProbeOutput, thumbnailTimeFor } from './media-probe.service';

const ffprobeJson = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    streams: [
      {
        codec_type: 'video',
        codec_name: 'h264',
        width: 1920,
        height: 1080,
        avg_frame_rate: '30000/1001',
      },
      { codec_type: 'audio', codec_name: 'aac' },
    ],
    format: {
      duration: '12.3456',
      format_name: 'mov,mp4,m4a',
      bit_rate: '4500000',
    },
    ...overrides,
  });

describe('parseProbeOutput', () => {
  it('extracts duration and metadata from ffprobe JSON', () => {
    expect(parseProbeOutput(ffprobeJson())).toEqual({
      durationSeconds: 12.346,
      metadata: {
        formatName: 'mov,mp4,m4a',
        bitRate: 4500000,
        width: 1920,
        height: 1080,
        videoCodec: 'h264',
        audioCodec: 'aac',
        frameRate: 29.97,
      },
    });
  });

  it('accepts videos without audio and an unknown frame rate', () => {
    const result = parseProbeOutput(
      ffprobeJson({
        streams: [
          { codec_type: 'video', codec_name: 'vp9', avg_frame_rate: '0/0' },
        ],
      }),
    );
    expect(result.metadata.audioCodec).toBeNull();
    expect(result.metadata.frameRate).toBeNull();
  });

  it('rejects files without a video stream', () => {
    expect(() =>
      parseProbeOutput(ffprobeJson({ streams: [{ codec_type: 'audio' }] })),
    ).toThrow(InvalidMediaError);
  });

  it('rejects a missing or zero duration', () => {
    expect(() =>
      parseProbeOutput(ffprobeJson({ format: { duration: '0' } })),
    ).toThrow(InvalidMediaError);
    expect(() => parseProbeOutput(ffprobeJson({ format: {} }))).toThrow(
      InvalidMediaError,
    );
  });

  it('rejects unreadable output', () => {
    expect(() => parseProbeOutput('not json')).toThrow(InvalidMediaError);
  });
});

describe('thumbnailTimeFor', () => {
  it('takes the frame at 10% of the duration', () => {
    expect(thumbnailTimeFor(120)).toBe(12);
    expect(thumbnailTimeFor(2.5)).toBe(0.25);
  });

  it('uses the first frame for clips shorter than one second', () => {
    expect(thumbnailTimeFor(0.4)).toBe(0);
  });
});
