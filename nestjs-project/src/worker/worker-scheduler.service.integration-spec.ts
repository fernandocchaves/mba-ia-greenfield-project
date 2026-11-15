import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QueueModule } from '../queue/queue.module';
import {
  ABANDONED_UPLOAD_SWEEP_EVERY_MS,
  ABANDONED_UPLOAD_SWEEP_SCHEDULER,
  SWEEP_ABANDONED_UPLOADS_JOB,
  VIDEO_PROCESSING_QUEUE,
} from '../videos/videos.constants';
import { WorkerSchedulerService } from './worker-scheduler.service';

describe('WorkerSchedulerService (integration — real Redis)', () => {
  let module: TestingModule;
  let queue: Queue;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
      providers: [WorkerSchedulerService],
    }).compile();
    queue = module.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await module.close();
  });

  it('registers the hourly sweep scheduler and stays idempotent across boots', async () => {
    const scheduler = module.get(WorkerSchedulerService);

    await scheduler.onApplicationBootstrap();
    await scheduler.onApplicationBootstrap();

    const schedulers = await queue.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toMatchObject({
      key: ABANDONED_UPLOAD_SWEEP_SCHEDULER,
      name: SWEEP_ABANDONED_UPLOADS_JOB,
      every: ABANDONED_UPLOAD_SWEEP_EVERY_MS,
    });
  });
});
