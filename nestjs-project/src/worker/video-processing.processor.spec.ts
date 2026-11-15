import { Job, UnrecoverableError } from 'bullmq';
import {
  PROCESS_VIDEO_JOB,
  SWEEP_ABANDONED_UPLOADS_JOB,
} from '../videos/videos.constants';
import { VideoProcessingProcessor } from './video-processing.processor';

const job = (overrides: Partial<Job> = {}): Job =>
  ({
    id: 'video-1',
    name: PROCESS_VIDEO_JOB,
    data: { videoId: 'video-1' },
    attemptsMade: 1,
    opts: { attempts: 3 },
    ...overrides,
  }) as Job;

describe('VideoProcessingProcessor (unit)', () => {
  let processing: { process: jest.Mock; markFailed: jest.Mock };
  let processor: VideoProcessingProcessor;

  beforeEach(() => {
    processing = {
      process: jest.fn().mockResolvedValue('processed'),
      markFailed: jest.fn().mockResolvedValue(undefined),
    };
    processor = new VideoProcessingProcessor(processing as never);
  });

  it('dispatches process-video jobs to the processing service', async () => {
    await expect(processor.process(job())).resolves.toBe('processed');
    expect(processing.process).toHaveBeenCalledWith('video-1');
  });

  it('rejects unknown job names without retrying', async () => {
    await expect(
      processor.process(job({ name: 'mystery' })),
    ).rejects.toBeInstanceOf(UnrecoverableError);
  });

  it('does not mark failed while retries remain', async () => {
    await processor.onFailed(job({ attemptsMade: 1 }), new Error('timeout'));
    expect(processing.markFailed).not.toHaveBeenCalled();
  });

  it('marks failed after the last attempt', async () => {
    await processor.onFailed(job({ attemptsMade: 3 }), new Error('timeout'));
    expect(processing.markFailed).toHaveBeenCalledWith('video-1', 'timeout');
  });

  it('marks failed immediately on an unrecoverable error', async () => {
    await processor.onFailed(
      job({ attemptsMade: 1 }),
      new UnrecoverableError('Invalid media: no video stream'),
    );
    expect(processing.markFailed).toHaveBeenCalledWith(
      'video-1',
      'Invalid media: no video stream',
    );
  });

  it('ignores failures of other job types', async () => {
    await processor.onFailed(
      job({ name: SWEEP_ABANDONED_UPLOADS_JOB, attemptsMade: 3 }),
      new Error('boom'),
    );
    expect(processing.markFailed).not.toHaveBeenCalled();
  });
});
