import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module';
import { VIDEO_PROCESSING_QUEUE } from './videos/videos.constants';

/** Entrypoint of the video worker container (`npm run start:worker`). */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  new Logger('Worker').log(
    `Video worker started — consuming the "${VIDEO_PROCESSING_QUEUE}" queue`,
  );
}
void bootstrap();
