import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { StorageModule } from '../storage/storage.module';
import { Video } from '../videos/entities/video.entity';
import { MediaProbeService } from './media-probe.service';
import { VideoProcessingService } from './video-processing.service';

@Module({
  imports: [TypeOrmModule.forFeature([Video]), StorageModule],
  providers: [MediaProbeService, VideoProcessingService],
  exports: [VideoProcessingService],
})
export class VideoProcessingModule {}
