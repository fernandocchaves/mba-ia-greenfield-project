import { randomUUID } from 'node:crypto';
import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QueueModule } from '../queue/queue.module';
import { VideoProcessingProducer } from './video-processing.producer';
import { PROCESS_VIDEO_JOB, VIDEO_PROCESSING_QUEUE } from './videos.constants';

describe('VideoProcessingProducer (integration — real Redis)', () => {
  let module: TestingModule;
  let producer: VideoProcessingProducer;
  let queue: Queue;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
      providers: [VideoProcessingProducer],
    }).compile();
    producer = module.get(VideoProcessingProducer);
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
  });

  beforeEach(async () => {
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
  });

  it('uses the isolated test prefix', () => {
    expect(queue.opts.prefix).toBe('streamtube-test');
  });

  it('publishes one process-video job per video with the retry policy', async () => {
    const videoId = randomUUID();

    await producer.enqueueProcessing(videoId);

    const job = await queue.getJob(videoId);
    expect(job).toBeDefined();
    expect(job!.name).toBe(PROCESS_VIDEO_JOB);
    expect(job!.data).toEqual({ videoId });
    expect(job!.opts.attempts).toBe(3);
    expect(job!.opts.backoff).toEqual({ type: 'exponential', delay: 5000 });
  });

  it('ignores a second enqueue for the same video', async () => {
    const videoId = randomUUID();

    await producer.enqueueProcessing(videoId);
    await producer.enqueueProcessing(videoId);

    const jobs = await queue.getJobs(['waiting', 'delayed', 'active']);
    expect(jobs.filter((j) => j.id === videoId)).toHaveLength(1);
  });
});
