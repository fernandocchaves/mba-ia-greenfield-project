import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageModule } from '../storage/storage.module';
import { Video } from '../videos/entities/video.entity';
import { AbandonedUploadSweeperService } from './abandoned-upload-sweeper.service';
import { MediaProbeService } from './media-probe.service';
import { VideoProcessingService } from './video-processing.service';

@Module({
  imports: [TypeOrmModule.forFeature([Video]), StorageModule],
  providers: [
    MediaProbeService,
    VideoProcessingService,
    AbandonedUploadSweeperService,
  ],
  exports: [VideoProcessingService, AbandonedUploadSweeperService],
})
export class VideoProcessingModule {}
