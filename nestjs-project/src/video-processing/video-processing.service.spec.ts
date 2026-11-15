import { UnrecoverableError } from 'bullmq';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { InvalidMediaError } from './media.errors';
import { VideoProcessingService } from './video-processing.service';

describe('VideoProcessingService (unit)', () => {
  let repo: { findOneBy: jest.Mock; update: jest.Mock };
  let storage: { downloadToFile: jest.Mock; putObject: jest.Mock };
  let probe: { probe: jest.Mock; extractThumbnail: jest.Mock };
  let service: VideoProcessingService;

  const processing = {
    id: 'video-1',
    status: VideoStatus.PROCESSING,
    storage_key: 'videos/video-1/source',
  } as Video;

  beforeEach(() => {
    repo = {
      findOneBy: jest.fn(),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    storage = {
      downloadToFile: jest.fn().mockResolvedValue(undefined),
      putObject: jest.fn().mockResolvedValue(undefined),
    };
    probe = { probe: jest.fn(), extractThumbnail: jest.fn() };
    service = new VideoProcessingService(
      repo as never,
      storage as never,
      probe as never,
    );
  });

  it.each([VideoStatus.DRAFT, VideoStatus.READY, VideoStatus.FAILED])(
    'skips a video in %s without touching storage',
    async (status) => {
      repo.findOneBy.mockResolvedValue({ ...processing, status });

      await expect(service.process('video-1')).resolves.toBe('skipped');
      expect(storage.downloadToFile).not.toHaveBeenCalled();
    },
  );

  it('skips a video that no longer exists', async () => {
    repo.findOneBy.mockResolvedValue(null);
    await expect(service.process('gone')).resolves.toBe('skipped');
  });

  it('turns invalid media into an UnrecoverableError (no retries)', async () => {
    repo.findOneBy.mockResolvedValue(processing);
    probe.probe.mockRejectedValue(new InvalidMediaError('no video stream'));

    await expect(service.process('video-1')).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('lets transient errors propagate so the queue retries', async () => {
    repo.findOneBy.mockResolvedValue(processing);
    storage.downloadToFile.mockRejectedValue(new Error('storage timeout'));

    const error: unknown = await service
      .process('video-1')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UnrecoverableError);
  });

  it('markFailed never overwrites a ready video', async () => {
    await service.markFailed('video-1', 'boom');

    const [criteria, changes] = repo.update.mock.calls[0] as [
      { id: string; status: unknown },
      Partial<Video>,
    ];
    expect(criteria.id).toBe('video-1');
    expect(criteria.status).toMatchObject({
      _type: 'not',
      _value: VideoStatus.READY,
    });
    expect(changes).toEqual({
      status: VideoStatus.FAILED,
      processing_error: 'boom',
    });
  });
});
