import { registerAs } from '@nestjs/config';

/**
 * Queue broker settings (phase-03-videos/TD-01, TD-11).
 *
 * `prefix` namespaces every BullMQ key. Jest sets it to `streamtube-test` so
 * test jobs are never consumed by the Compose `worker` (TD-11 revision).
 */
export default registerAs('queue', () => ({
  host: process.env.REDIS_HOST || 'redis',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  prefix: process.env.QUEUE_PREFIX || 'streamtube',
}));
