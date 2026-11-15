// Isolates BullMQ keys used by tests from the Compose `worker`, which consumes
// the default `streamtube` prefix (phase-03-videos/TD-11 revision). Loaded by
// both Jest configs after `dotenv/config`.
process.env.QUEUE_PREFIX = 'streamtube-test';
