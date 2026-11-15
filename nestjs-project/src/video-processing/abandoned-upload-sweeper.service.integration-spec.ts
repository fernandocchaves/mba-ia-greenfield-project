import { randomUUID } from 'node:crypto';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { StorageUploadNotFoundError } from '../storage/storage.errors';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import {
  AbandonedUploadSweeperService,
  UPLOAD_ABANDONED_REASON,
} from './abandoned-upload-sweeper.service';
import { VideoProcessingModule } from './video-processing.module';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];
const HOUR = 60 * 60 * 1000;

describe('AbandonedUploadSweeperService (integration — real DB + storage)', () => {
  let module: TestingModule;
  let sweeper: AbandonedUploadSweeperService;
  let storage: StorageService;
  let videos: Repository<Video>;
  let dataSource: DataSource;
  let channel: Channel;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideoProcessingModule,
      ],
    }).compile();
    await module.init();
    sweeper = module.get(AbandonedUploadSweeperService);
    storage = module.get(StorageService);
    videos = module.get(getRepositoryToken(Video));
    dataSource = module.get(DataSource);
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    const user = await dataSource.getRepository(User).save({
      email: `sweep_${randomUUID()}@example.com`,
      password: 'hashed',
    });
    channel = await dataSource.getRepository(Channel).save({
      name: 'sweeper',
      nickname: `sweep_${randomUUID().slice(0, 8)}`,
      user_id: user.id,
    });
  });

  async function createVideo(
    status: VideoStatus,
    ageMs: number,
    withUpload: boolean,
  ): Promise<Video> {
    const id = randomUUID();
    const key = `videos/${id}/source`;
    const uploadId = withUpload
      ? await storage.createMultipartUpload(key, 'video/mp4')
      : null;
    const video = await videos.save({
      id,
      url_id: id.replace(/-/g, '').slice(0, 11),
      channel_id: channel.id,
      title: 'Maybe abandoned',
      status,
      original_filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 10,
      storage_key: key,
      upload_id: uploadId,
    });
    await videos.query('UPDATE videos SET created_at = $1 WHERE id = $2', [
      new Date(Date.now() - ageMs),
      id,
    ]);
    return video;
  }

  it('fails drafts older than 24h and aborts their multipart upload', async () => {
    const old = await createVideo(VideoStatus.DRAFT, 25 * HOUR, true);

    await expect(sweeper.sweep(new Date())).resolves.toBe(1);

    const swept = await videos.findOneByOrFail({ id: old.id });
    expect(swept.status).toBe(VideoStatus.FAILED);
    expect(swept.processing_error).toBe(UPLOAD_ABANDONED_REASON);
    expect(swept.upload_id).toBeNull();
    await expect(
      storage.listUploadedParts(old.storage_key, old.upload_id!),
    ).rejects.toBeInstanceOf(StorageUploadNotFoundError);
  });

  it('tolerates a multipart upload the storage already purged', async () => {
    const old = await createVideo(VideoStatus.DRAFT, 25 * HOUR, true);
    await storage.abortMultipartUpload(old.storage_key, old.upload_id!);

    await expect(sweeper.sweep(new Date())).resolves.toBe(1);
    expect((await videos.findOneByOrFail({ id: old.id })).status).toBe(
      VideoStatus.FAILED,
    );
  });

  it('leaves recent drafts and non-draft videos untouched', async () => {
    const recent = await createVideo(VideoStatus.DRAFT, 1 * HOUR, true);
    const ready = await createVideo(VideoStatus.READY, 48 * HOUR, false);
    const processing = await createVideo(
      VideoStatus.PROCESSING,
      48 * HOUR,
      false,
    );

    await expect(sweeper.sweep(new Date())).resolves.toBe(0);

    expect((await videos.findOneByOrFail({ id: recent.id })).status).toBe(
      VideoStatus.DRAFT,
    );
    expect((await videos.findOneByOrFail({ id: ready.id })).status).toBe(
      VideoStatus.READY,
    );
    expect((await videos.findOneByOrFail({ id: processing.id })).status).toBe(
      VideoStatus.PROCESSING,
    );
    await storage.abortMultipartUpload(recent.storage_key, recent.upload_id!);
  });
});
