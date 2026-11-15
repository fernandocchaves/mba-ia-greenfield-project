import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideoProcessingProducer } from './video-processing.producer';
import { VIDEO_PROCESSING_QUEUE } from './videos.constants';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    ChannelsModule,
    StorageModule,
    QueueModule,
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
  ],
  controllers: [VideosController],
  providers: [VideosService, VideoProcessingProducer],
  exports: [VideosService],
})
export class VideosModule {}
