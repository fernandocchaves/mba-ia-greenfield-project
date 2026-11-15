import { randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { generateUrlId } from '../url-id.util';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    counter++;
    const user = await dataSource.getRepository(User).save({
      email: `video_owner_${counter}@example.com`,
      password: 'hashed',
    });
    return dataSource.getRepository(Channel).save({
      name: `owner${counter}`,
      nickname: `owner_${counter}`,
      user_id: user.id,
    });
  }

  function buildVideo(channelId: string, overrides: Partial<Video> = {}) {
    const id = randomUUID();
    return videoRepository.create({
      id,
      url_id: generateUrlId(),
      channel_id: channelId,
      title: 'My video',
      original_filename: 'clip.mp4',
      content_type: 'video/mp4',
      size_bytes: 1024,
      storage_key: `videos/${id}/source`,
      upload_id: 'upload-1',
      ...overrides,
    });
  }

  it('defaults status to draft and leaves processing fields null', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(buildVideo(channel.id));
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.status).toBe(VideoStatus.DRAFT);
    expect(found.duration_seconds).toBeNull();
    expect(found.metadata).toBeNull();
    expect(found.thumbnail_key).toBeNull();
    expect(found.processing_error).toBeNull();
    expect(found.processed_at).toBeNull();
  });

  it('enforces a unique url_id', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      buildVideo(channel.id, { url_id: 'AAAAAAAAAAA' }),
    );

    await expect(
      videoRepository.save(buildVideo(channel.id, { url_id: 'AAAAAAAAAAA' })),
    ).rejects.toBeInstanceOf(QueryFailedError);
  });

  it('round-trips a 10 GiB size and fractional duration as numbers', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(
      buildVideo(channel.id, {
        size_bytes: 10_737_418_240,
        duration_seconds: 12.345,
        metadata: {
          formatName: 'mov,mp4',
          bitRate: 1000,
          width: 320,
          height: 240,
          videoCodec: 'h264',
          audioCodec: null,
          frameRate: 25,
        },
      }),
    );
    const found = await videoRepository.findOneByOrFail({ id: saved.id });

    expect(found.size_bytes).toBe(10_737_418_240);
    expect(found.duration_seconds).toBe(12.345);
    expect(found.metadata?.width).toBe(320);
  });

  it('is deleted when its channel is deleted (ON DELETE CASCADE)', async () => {
    const channel = await createChannel();
    const saved = await videoRepository.save(buildVideo(channel.id));

    await dataSource.getRepository(Channel).delete({ id: channel.id });

    expect(await videoRepository.findOneBy({ id: saved.id })).toBeNull();
  });
});
