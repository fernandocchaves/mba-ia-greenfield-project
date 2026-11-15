import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
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
import { VideosModule } from './videos.module';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideosService (integration — real DB + storage)', () => {
  let module: TestingModule;
  let service: VideosService;
  let storage: StorageService;
  let videoRepository: Repository<Video>;
  let dataSource: DataSource;

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
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
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
});
