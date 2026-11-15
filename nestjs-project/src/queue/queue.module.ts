import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';

/**
 * Shared BullMQ connection for the API and the worker (phase-03-videos/TD-01).
 * `prefix` isolates key spaces per environment (TD-11 revision).
 */
@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
        connection: { host: cfg.host, port: cfg.port },
        prefix: cfg.prefix,
      }),
    }),
  ],
})
export class QueueModule {}
