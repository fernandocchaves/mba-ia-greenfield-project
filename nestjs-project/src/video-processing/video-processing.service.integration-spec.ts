import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { UnrecoverableError } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsService } from '../channels/channels.service';
import { ChannelsModule } from '../channels/channels.module';
import { Channel } from '../channels/entities/channel.entity';
import storageConfig from '../config/storage.config';
import { StorageService } from '../storage/storage.service';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from '../videos/entities/video.entity';
import { VideoProcessingModule } from './video-processing.module';
import { VideoProcessingService } from './video-processing.service';

const execFileAsync = promisify(execFile);
const ALL_ENTITIES = [User, Channel, RefreshToken, VerificationToken, Video];

describe('VideoProcessingService (integration — real DB + storage + FFmpeg)', () => {
  let module: TestingModule;
  let service: VideoProcessingService;
  let storage: StorageService;
  let videoRepository: Repository<Video>;
  let dataSource: DataSource;
  let workDir: string;
  let clip: Buffer;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        VideoProcessingModule,
        ChannelsModule,
      ],
    }).compile();
    await module.init();
    service = module.get(VideoProcessingService);
    storage = module.get(StorageService);
    videoRepository = module.get(getRepositoryToken(Video));
    dataSource = module.get(DataSource);

    workDir = await mkdtemp(join(tmpdir(), 'processing-it-'));
    const clipPath = join(workDir, 'clip.mp4');
    await execFileAsync('ffmpeg', [
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=320x240:rate=25',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      clipPath,
    ]);
    clip = await readFile(clipPath);
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
    await module.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createProcessingVideo(body: Buffer): Promise<Video> {
    counter++;
    const user = await dataSource.getRepository(User).save({
      email: `processing_${counter}@example.com`,
      password: 'hashed',
    });
    const channel = await module
      .get(ChannelsService)
      .createChannel(user.id, user.email);
    const id = randomUUID();
    const key = `videos/${id}/source`;
    await storage.putObject(key, body, 'video/mp4');
    return videoRepository.save(
      videoRepository.create({
        id,
        url_id: id.replace(/-/g, '').slice(0, 11),
        channel_id: channel.id,
        title: 'To process',
        status: VideoStatus.PROCESSING,
        original_filename: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: body.length,
        storage_key: key,
        upload_id: null,
      }),
    );
  }

  it('turns a processing video into ready with duration, metadata and a stored thumbnail', async () => {
    const video = await createProcessingVideo(clip);

    await expect(service.process(video.id)).resolves.toBe('processed');

    const done = await videoRepository.findOneByOrFail({ id: video.id });
    expect(done.status).toBe(VideoStatus.READY);
    expect(done.duration_seconds).toBeCloseTo(2, 0);
    expect(done.metadata).toMatchObject({
      width: 320,
      height: 240,
      videoCodec: 'h264',
    });
    expect(done.thumbnail_key).toBe(`videos/${video.id}/thumbnail.jpg`);
    expect(done.processed_at).toBeInstanceOf(Date);

    const url = await storage.presignGetObject(done.thumbnail_key!, {
      expiresInSeconds: 60,
    });
    const thumb = await fetch(url);
    expect(thumb.headers.get('content-type')).toBe('image/jpeg');
    expect((await thumb.arrayBuffer()).byteLength).toBeGreaterThan(100);
  });

  it('does nothing when the same job is delivered again', async () => {
    const video = await createProcessingVideo(clip);
    await service.process(video.id);

    await expect(service.process(video.id)).resolves.toBe('skipped');
  });

  it('rejects a file that is not a video without retries, then markFailed records it', async () => {
    const video = await createProcessingVideo(
      Buffer.from('not a video at all'),
    );

    await expect(service.process(video.id)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(
      (await videoRepository.findOneByOrFail({ id: video.id })).status,
    ).toBe(VideoStatus.PROCESSING);

    await service.markFailed(video.id, 'Invalid media: no video stream');

    const failed = await videoRepository.findOneByOrFail({ id: video.id });
    expect(failed.status).toBe(VideoStatus.FAILED);
    expect(failed.processing_error).toBe('Invalid media: no video stream');
  });

  it('markFailed leaves a ready video untouched', async () => {
    const video = await createProcessingVideo(clip);
    await service.process(video.id);

    await service.markFailed(video.id, 'late failure');

    expect(
      (await videoRepository.findOneByOrFail({ id: video.id })).status,
    ).toBe(VideoStatus.READY);
  });
});
