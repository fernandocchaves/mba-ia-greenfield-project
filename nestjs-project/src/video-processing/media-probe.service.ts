import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Injectable } from '@nestjs/common';
import type { VideoMetadata } from '../videos/entities/video.entity';
import { InvalidMediaError } from './media.errors';

const execFileAsync = promisify(execFile);

/** ffprobe/ffmpeg wall-clock limits; generous for multi-GB files. */
const PROBE_TIMEOUT_MS = 60_000;
const THUMBNAIL_TIMEOUT_MS = 120_000;
/** ffprobe JSON for long files with many streams can exceed the 1 MiB default. */
const MAX_BUFFER_BYTES = 10 * 1024 * 1024;
const THUMBNAIL_MAX_WIDTH = 1280;
const THUMBNAIL_POSITION = 0.1;

export interface ProbeResult {
  durationSeconds: number;
  metadata: VideoMetadata;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
}

interface FfprobeOutput {
  format?: { duration?: string; format_name?: string; bit_rate?: string };
  streams?: FfprobeStream[];
}

const toNumber = (value: string | undefined): number | null => {
  if (value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** `"30000/1001"` → 29.97; `"0/0"` → null. */
const parseFrameRate = (value: string | undefined): number | null => {
  if (!value) return null;
  const [num, den] = value.split('/').map(Number);
  if (!den || !Number.isFinite(num) || !Number.isFinite(den)) return null;
  return Math.round((num / den) * 1000) / 1000;
};

/** Turns ffprobe's JSON into duration + metadata; pure, so it is unit-testable. */
export function parseProbeOutput(raw: string): ProbeResult {
  let parsed: FfprobeOutput;
  try {
    parsed = JSON.parse(raw) as FfprobeOutput;
  } catch {
    throw new InvalidMediaError('ffprobe returned unreadable output');
  }
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  if (!video) throw new InvalidMediaError('no video stream');

  const duration = toNumber(parsed.format?.duration);
  if (duration === null || duration <= 0) {
    throw new InvalidMediaError('unknown duration');
  }
  const audio = streams.find((s) => s.codec_type === 'audio');

  return {
    durationSeconds: Math.round(duration * 1000) / 1000,
    metadata: {
      formatName: parsed.format?.format_name ?? null,
      bitRate: toNumber(parsed.format?.bit_rate),
      width: video.width ?? null,
      height: video.height ?? null,
      videoCodec: video.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null,
      frameRate: parseFrameRate(video.avg_frame_rate),
    },
  };
}

/** Instant used for the thumbnail: 10% into the video, 0 for very short clips. */
export function thumbnailTimeFor(durationSeconds: number): number {
  if (durationSeconds < 1) return 0;
  return Math.round(durationSeconds * THUMBNAIL_POSITION * 1000) / 1000;
}

/**
 * Thin wrapper over the system `ffprobe`/`ffmpeg` binaries (phase-03-videos/TD-06).
 * Uses `execFile` with argument arrays — no shell, no injection surface.
 */
@Injectable()
export class MediaProbeService {
  async probe(filePath: string): Promise<ProbeResult> {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(
        'ffprobe',
        [
          '-v',
          'error',
          '-print_format',
          'json',
          '-show_format',
          '-show_streams',
          filePath,
        ],
        { timeout: PROBE_TIMEOUT_MS, maxBuffer: MAX_BUFFER_BYTES },
      ));
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr?.trim();
      throw new InvalidMediaError(stderr || 'ffprobe failed');
    }
    return parseProbeOutput(stdout);
  }

  async extractThumbnail(
    filePath: string,
    atSeconds: number,
    outputPath: string,
  ): Promise<void> {
    await execFileAsync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-y',
        '-ss',
        atSeconds.toString(),
        '-i',
        filePath,
        '-frames:v',
        '1',
        '-vf',
        `scale='min(${THUMBNAIL_MAX_WIDTH},iw)':-2`,
        '-q:v',
        '3',
        outputPath,
      ],
      { timeout: THUMBNAIL_TIMEOUT_MS },
    );
  }
}
