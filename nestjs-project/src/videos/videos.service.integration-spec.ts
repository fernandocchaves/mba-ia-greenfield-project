import { getQueueToken } from '@nestjs/bullmq';
import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { PROCESS_VIDEO_JOB, VIDEO_PROCESSING_QUEUE } from './videos.constants';
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration — real DB + storage)', () => {
  let module: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let videoRepository: Repository<Video>;
  let dataSource: DataSource;
  let queue: Queue;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideosModule,
      ],
    }).compile();
    await module.init();
    service = module.get(VideosService);
    storage = module.get(StorageService);
    videoRepository = module.get(getRepositoryToken(Video));
    dataSource = module.get(DataSource);
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
  });

  let counter = 0;
  async function createOwner(): Promise<User> {
    counter++;
    const user = await dataSource.getRepository(User).save({
      email: `uploader_${counter}@example.com`,
      password: 'hashed',
    });
    await module.get(ChannelsService).createChannel(user.id, user.email);
    return user;
  }

  it('initiateUpload persists a draft and opens a real multipart upload', async () => {
    const owner = await createOwner();

    const result = await service.initiateUpload(owner.id, {
      title: 'Integration clip',
      filename: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: 20,
    });

    const video = await videoRepository.findOneByOrFail({
      url_id: result.urlId,
    });
    expect(video.status).toBe(VideoStatus.DRAFT);
    expect(video.upload_id).toBeTruthy();
    await expect(
      storage.listUploadedParts(video.storage_key, video.upload_id!),
    ).resolves.toEqual([]);
  });

  it('presigned part URLs accept a direct PUT to storage', async () => {
    const owner = await createOwner();
    const { urlId } = await service.initiateUpload(owner.id, {
      title: 'Clip',
      filename: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: 12,
    });

    const { parts } = await service.presignUploadParts(owner.id, urlId, [1]);
    const res = await fetch(parts[0].url, {
      method: 'PUT',
      body: new Uint8Array(Buffer.from('hello world!')),
    });
    expect(res.status).toBe(200);

    const video = await videoRepository.findOneByOrFail({ url_id: urlId });
    const uploaded = await storage.listUploadedParts(
      video.storage_key,
      video.upload_id!,
    );
    expect(uploaded).toEqual([
      expect.objectContaining({ partNumber: 1, size: 12 }),
    ]);
  });

  it('completeUpload assembles the object in storage, marks processing and enqueues a job', async () => {
    const owner = await createOwner();
    const body = Buffer.from('hello world!');
    const { urlId } = await service.initiateUpload(owner.id, {
      title: 'Clip',
      filename: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: body.length,
    });
    const { parts } = await service.presignUploadParts(owner.id, urlId, [1]);
    await fetch(parts[0].url, { method: 'PUT', body: new Uint8Array(body) });

    const result = await service.completeUpload(owner.id, urlId);

    expect(result.status).toBe(VideoStatus.PROCESSING);
    const video = await videoRepository.findOneByOrFail({ url_id: urlId });
    expect(video.status).toBe(VideoStatus.PROCESSING);
    expect(video.upload_id).toBeNull();

    const url = await storage.presignGetObject(video.storage_key, {
      expiresInSeconds: 60,
    });
    expect(await (await fetch(url)).text()).toBe('hello world!');

    const job = await queue.getJob(video.id);
    expect(job?.name).toBe(PROCESS_VIDEO_JOB);
    expect(job?.data).toEqual({ videoId: video.id });
  });

  it('completeUpload rejects when no part was uploaded and keeps the draft', async () => {
    const owner = await createOwner();
    const { urlId } = await service.initiateUpload(owner.id, {
      title: 'Clip',
      filename: 'clip.mp4',
      contentType: 'video/mp4',
      sizeBytes: 12,
    });

    await expect(service.completeUpload(owner.id, urlId)).rejects.toMatchObject(
      {
        errorCode: 'UPLOAD_INCOMPLETE',
      },
    );
    const video = await videoRepository.findOneByOrFail({ url_id: urlId });
    expect(video.status).toBe(VideoStatus.DRAFT);
  });

  async function createReadyVideo(owner: User, body: Buffer): Promise<Video> {
    const channel = await module.get(ChannelsService).findByUserId(owner.id);
    const id = randomUUID();
    const key = `videos/${id}/source`;
    await storage.putObject(key, body, 'video/mp4');
    return videoRepository.save(
      videoRepository.create({
        id,
        url_id: id.replace(/-/g, '').slice(0, 11),
        channel_id: channel!.id,
        title: 'Ready clip',
        status: VideoStatus.READY,
        original_filename: 'ready clip.mp4',
        content_type: 'video/mp4',
        size_bytes: body.length,
        storage_key: key,
        upload_id: null,
        processed_at: new Date(),
      }),
    );
  }

  it('playback URL streams: storage answers Range with 206 Partial Content', async () => {
    const owner = await createOwner();
    const video = await createReadyVideo(
      owner,
      Buffer.from('0123456789abcdefghij'),
    );

    const { url } = await service.getPlaybackUrl(owner.id, video.url_id);
    const res = await fetch(url, { headers: { Range: 'bytes=5-9' } });

    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 5-9/20');
    expect(await res.text()).toBe('56789');
  });

  it('download URL is served as an attachment named after the original file', async () => {
    const owner = await createOwner();
    const video = await createReadyVideo(owner, Buffer.from('download me'));

    const { url } = await service.getDownloadUrl(owner.id, video.url_id);
    const res = await fetch(url);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="ready clip.mp4"',
    );
    expect(await res.text()).toBe('download me');
  });
});
