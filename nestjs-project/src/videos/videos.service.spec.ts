import { QueryFailedError } from 'typeorm';
import { StorageUploadNotFoundError } from '../storage/storage.errors';
import { Video, VideoStatus } from './entities/video.entity';
import {
  InvalidPartNumberException,
  UploadExpiredException,
  UploadIncompleteException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoNotUploadableException,
  VideoTooLargeException,
} from './video.exceptions';
import {
  MAX_VIDEO_SIZE_BYTES,
  UPLOAD_PART_SIZE_BYTES,
} from './videos.constants';
import { VideosService } from './videos.service';

function uniqueViolation(column: string): QueryFailedError {
  const err = new QueryFailedError('INSERT', [], new Error('duplicate'));
  Object.assign(err, {
    code: '23505',
    detail: `Key (${column})=(x) already exists.`,
  });
  return err;
}

describe('VideosService (unit)', () => {
  let repo: { create: jest.Mock; save: jest.Mock; findOne: jest.Mock };
  let channels: { findByUserId: jest.Mock };
  let storage: {
    createMultipartUpload: jest.Mock;
    abortMultipartUpload: jest.Mock;
    presignUploadPart: jest.Mock;
    presignGetObject: jest.Mock;
    listUploadedParts: jest.Mock;
    completeMultipartUpload: jest.Mock;
  };
  let producer: { enqueueProcessing: jest.Mock };
  let service: VideosService;

  const savedVideo = (call: number): Video =>
    (repo.save.mock.calls as [Video][])[call][0];

  const dto = {
    title: 'Clip',
    filename: 'clip.mp4',
    contentType: 'video/mp4',
    sizeBytes: UPLOAD_PART_SIZE_BYTES * 2 + 1,
  };

  beforeEach(() => {
    repo = {
      create: jest.fn((fields: Partial<Video>) => fields),
      save: jest.fn((v: Video) => Promise.resolve(v)),
      findOne: jest.fn(),
    };
    channels = { findByUserId: jest.fn().mockResolvedValue({ id: 'ch-1' }) };
    storage = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-1'),
      abortMultipartUpload: jest.fn().mockResolvedValue(undefined),
      presignUploadPart: jest.fn((_k: string, _u: string, n: number) =>
        Promise.resolve(`https://storage/part-${n}`),
      ),
      presignGetObject: jest.fn((key: string) =>
        Promise.resolve(`https://storage/${key}`),
      ),
      listUploadedParts: jest.fn(),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
    };
    producer = { enqueueProcessing: jest.fn().mockResolvedValue(undefined) };
    service = new VideosService(
      repo as never,
      channels as never,
      storage as never,
      producer as never,
    );
  });

  describe('initiateUpload', () => {
    it('rejects files above 10 GiB before touching storage', async () => {
      await expect(
        service.initiateUpload('u-1', {
          ...dto,
          sizeBytes: MAX_VIDEO_SIZE_BYTES + 1,
        }),
      ).rejects.toBeInstanceOf(VideoTooLargeException);
      expect(storage.createMultipartUpload).not.toHaveBeenCalled();
    });

    it('accepts exactly 10 GiB and computes the part count', async () => {
      const result = await service.initiateUpload('u-1', {
        ...dto,
        sizeBytes: MAX_VIDEO_SIZE_BYTES,
      });
      expect(result.partCount).toBe(160);
      expect(result.partSize).toBe(UPLOAD_PART_SIZE_BYTES);
    });

    it('persists a draft keyed by its own id and returns the upload contract', async () => {
      const result = await service.initiateUpload('u-1', dto);

      const saved = savedVideo(0);
      expect(saved.status).toBe(VideoStatus.DRAFT);
      expect(saved.channel_id).toBe('ch-1');
      expect(saved.upload_id).toBe('upload-1');
      expect(saved.storage_key).toBe(`videos/${saved.id}/source`);
      expect(saved.url_id).toMatch(/^[A-Za-z0-9_-]{11}$/);
      expect(result).toEqual({
        urlId: saved.url_id,
        status: VideoStatus.DRAFT,
        partSize: UPLOAD_PART_SIZE_BYTES,
        partCount: 3,
        maxPartsPerRequest: 100,
      });
    });

    it('retries with a new url_id on a url_id collision', async () => {
      repo.save
        .mockRejectedValueOnce(uniqueViolation('url_id'))
        .mockImplementationOnce((v: Video) => Promise.resolve(v));

      await service.initiateUpload('u-1', dto);

      expect(repo.save).toHaveBeenCalledTimes(2);
      const first = savedVideo(0);
      const second = savedVideo(1);
      expect(second.url_id).not.toBe(first.url_id);
    });

    it('aborts the multipart upload when the draft cannot be persisted', async () => {
      repo.save.mockRejectedValue(new Error('db down'));

      await expect(service.initiateUpload('u-1', dto)).rejects.toThrow(
        'db down',
      );
      expect(storage.abortMultipartUpload).toHaveBeenCalledWith(
        expect.stringMatching(/^videos\/.+\/source$/),
        'upload-1',
      );
    });
  });

  describe('presignUploadParts', () => {
    const draft = {
      url_id: 'abc',
      status: VideoStatus.DRAFT,
      size_bytes: UPLOAD_PART_SIZE_BYTES * 2 + 1,
      storage_key: 'videos/v1/source',
      upload_id: 'upload-1',
    } as Video;

    it('returns one URL per requested part with an expiry', async () => {
      repo.findOne.mockResolvedValue(draft);

      const result = await service.presignUploadParts('u-1', 'abc', [1, 3]);

      expect(result.parts).toEqual([
        { partNumber: 1, url: 'https://storage/part-1' },
        { partNumber: 3, url: 'https://storage/part-3' },
      ]);
      expect(new Date(result.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('rejects part numbers beyond the part count', async () => {
      repo.findOne.mockResolvedValue(draft);
      await expect(
        service.presignUploadParts('u-1', 'abc', [4]),
      ).rejects.toBeInstanceOf(InvalidPartNumberException);
    });

    it('returns 404 for videos the user does not own', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        service.presignUploadParts('u-2', 'abc', [1]),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });

    it('rejects videos that are no longer drafts', async () => {
      repo.findOne.mockResolvedValue({
        ...draft,
        status: VideoStatus.PROCESSING,
        upload_id: null,
      });
      await expect(
        service.presignUploadParts('u-1', 'abc', [1]),
      ).rejects.toBeInstanceOf(VideoNotUploadableException);
    });
  });

  describe('completeUpload', () => {
    const size = UPLOAD_PART_SIZE_BYTES + 10;
    const draft = () =>
      ({
        id: 'video-1',
        url_id: 'abc',
        status: VideoStatus.DRAFT,
        size_bytes: size,
        storage_key: 'videos/video-1/source',
        upload_id: 'upload-1',
      }) as Video;
    const fullParts = [
      { partNumber: 1, eTag: '"a"', size: UPLOAD_PART_SIZE_BYTES },
      { partNumber: 2, eTag: '"b"', size: 10 },
    ];

    it('completes with the parts listed by storage, marks processing and enqueues once', async () => {
      repo.findOne.mockResolvedValue(draft());
      storage.listUploadedParts.mockResolvedValue(fullParts);

      const result = await service.completeUpload('u-1', 'abc');

      expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
        'videos/video-1/source',
        'upload-1',
        fullParts,
      );
      const saved = savedVideo(0);
      expect(saved.status).toBe(VideoStatus.PROCESSING);
      expect(saved.upload_id).toBeNull();
      expect(producer.enqueueProcessing).toHaveBeenCalledWith('video-1');
      expect(result).toEqual({ urlId: 'abc', status: VideoStatus.PROCESSING });
    });

    it('rejects an upload with a missing part', async () => {
      repo.findOne.mockResolvedValue(draft());
      storage.listUploadedParts.mockResolvedValue([fullParts[0]]);

      await expect(service.completeUpload('u-1', 'abc')).rejects.toBeInstanceOf(
        UploadIncompleteException,
      );
      expect(storage.completeMultipartUpload).not.toHaveBeenCalled();
      expect(producer.enqueueProcessing).not.toHaveBeenCalled();
    });

    it('rejects an upload whose size differs from the declared size', async () => {
      repo.findOne.mockResolvedValue(draft());
      storage.listUploadedParts.mockResolvedValue([
        fullParts[0],
        { ...fullParts[1], size: 9 },
      ]);

      await expect(service.completeUpload('u-1', 'abc')).rejects.toBeInstanceOf(
        UploadIncompleteException,
      );
    });

    it('maps a multipart upload missing in storage to UPLOAD_EXPIRED', async () => {
      repo.findOne.mockResolvedValue(draft());
      storage.listUploadedParts.mockRejectedValue(
        new StorageUploadNotFoundError('videos/video-1/source'),
      );

      await expect(service.completeUpload('u-1', 'abc')).rejects.toBeInstanceOf(
        UploadExpiredException,
      );
    });

    it('rejects videos that are no longer drafts', async () => {
      repo.findOne.mockResolvedValue({
        ...draft(),
        status: VideoStatus.PROCESSING,
        upload_id: null,
      });

      await expect(service.completeUpload('u-1', 'abc')).rejects.toBeInstanceOf(
        VideoNotUploadableException,
      );
    });
  });

  describe('read endpoints', () => {
    const ready = () =>
      ({
        id: 'video-1',
        url_id: 'abc',
        title: 'Clip',
        status: VideoStatus.READY,
        original_filename: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: 42,
        storage_key: 'videos/video-1/source',
        thumbnail_key: 'videos/video-1/thumbnail.jpg',
        duration_seconds: 2.5,
        metadata: null,
        processing_error: null,
        created_at: new Date('2026-11-14T10:00:00Z'),
        processed_at: new Date('2026-11-14T10:01:00Z'),
      }) as Video;

    it('getVideoDetails maps the entity and signs the thumbnail', async () => {
      repo.findOne.mockResolvedValue(ready());

      const details = await service.getVideoDetails('u-1', 'abc');

      expect(details).toMatchObject({
        urlId: 'abc',
        status: VideoStatus.READY,
        sizeBytes: 42,
        durationSeconds: 2.5,
        thumbnailUrl: 'https://storage/videos/video-1/thumbnail.jpg',
        createdAt: '2026-11-14T10:00:00.000Z',
        processedAt: '2026-11-14T10:01:00.000Z',
      });
    });

    it('getVideoDetails returns a null thumbnail before processing', async () => {
      repo.findOne.mockResolvedValue({
        ...ready(),
        status: VideoStatus.DRAFT,
        thumbnail_key: null,
        processed_at: null,
      });

      const details = await service.getVideoDetails('u-1', 'abc');
      expect(details.thumbnailUrl).toBeNull();
      expect(storage.presignGetObject).not.toHaveBeenCalled();
    });

    it('getPlaybackUrl signs an inline GET; getDownloadUrl signs an attachment', async () => {
      repo.findOne.mockResolvedValue(ready());

      await service.getPlaybackUrl('u-1', 'abc');
      await service.getDownloadUrl('u-1', 'abc');

      expect(storage.presignGetObject).toHaveBeenNthCalledWith(
        1,
        'videos/video-1/source',
        { expiresInSeconds: 900, downloadFilename: undefined },
      );
      expect(storage.presignGetObject).toHaveBeenNthCalledWith(
        2,
        'videos/video-1/source',
        { expiresInSeconds: 900, downloadFilename: 'clip.mp4' },
      );
    });

    it.each([VideoStatus.DRAFT, VideoStatus.PROCESSING, VideoStatus.FAILED])(
      'rejects playback and download while %s',
      async (status) => {
        repo.findOne.mockResolvedValue({ ...ready(), status });
        await expect(
          service.getPlaybackUrl('u-1', 'abc'),
        ).rejects.toBeInstanceOf(VideoNotReadyException);
        await expect(
          service.getDownloadUrl('u-1', 'abc'),
        ).rejects.toBeInstanceOf(VideoNotReadyException);
      },
    );

    it('returns 404 for videos of other channels', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(
        service.getVideoDetails('u-2', 'abc'),
      ).rejects.toBeInstanceOf(VideoNotFoundException);
    });
  });
});
