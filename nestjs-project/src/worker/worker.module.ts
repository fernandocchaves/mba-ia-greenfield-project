import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from '../channels/entities/channel.entity';
import appConfig from '../config/app.config';
import databaseConfig from '../config/database.config';
import { envValidationSchema } from '../config/env.validation';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { buildTypeOrmOptions } from '../database/typeorm-options';
import { QueueModule } from '../queue/queue.module';
import { User } from '../users/entities/user.entity';
import { VideoProcessingModule } from '../video-processing/video-processing.module';
import { Video } from '../videos/entities/video.entity';
import { VIDEO_PROCESSING_QUEUE } from '../videos/videos.constants';
import { VideoProcessingProcessor } from './video-processing.processor';
import { WorkerSchedulerService } from './worker-scheduler.service';

/**
 * Root module of the headless video worker (phase-03-videos/TD-05): same code
 * base and configuration as the API, no HTTP server.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, storageConfig, queueConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) =>
        buildTypeOrmOptions(dbConfig),
    }),
    // Video → Channel → User relation graph must be registered for metadata.
    TypeOrmModule.forFeature([Video, Channel, User]),
    QueueModule,
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
    VideoProcessingModule,
  ],
  providers: [VideoProcessingProcessor, WorkerSchedulerService],
})
export class WorkerModule {}
