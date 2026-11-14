import { envValidationSchema } from './env.validation';
import queueConfig from './queue.config';
import storageConfig from './storage.config';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  STORAGE_ENDPOINT: 'http://minio:9000',
  STORAGE_ACCESS_KEY: 'key',
  STORAGE_SECRET_KEY: 'secret',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const { value, error } = validate({});
    expect(error).toBeUndefined();
    expect(value.SWAGGER_ENABLED).toBe('false');
  });
});

describe('envValidationSchema — storage and queue (phase-03-videos/TD-11)', () => {
  const storageEnv = {
    STORAGE_ENDPOINT: 'http://minio:9000',
    STORAGE_ACCESS_KEY: 'key',
    STORAGE_SECRET_KEY: 'secret',
  };

  it.each(['STORAGE_ENDPOINT', 'STORAGE_ACCESS_KEY', 'STORAGE_SECRET_KEY'])(
    'should reject a missing %s',
    (key) => {
      const env: Record<string, unknown> = { ...requiredEnv };
      delete env[key];
      const { error } = envValidationSchema.validate(env, {
        allowUnknown: true,
        abortEarly: false,
      });
      expect(error).toBeDefined();
      expect(error!.message).toContain(key);
    },
  );

  it('should reject a STORAGE_ENDPOINT that is not a URI', () => {
    const { error } = validate({ ...storageEnv, STORAGE_ENDPOINT: 'minio' });
    expect(error!.message).toContain('STORAGE_ENDPOINT');
  });

  it('should apply defaults for region, bucket and queue settings', () => {
    const { value, error } = validate(storageEnv);
    expect(error).toBeUndefined();
    expect(value.STORAGE_REGION).toBe('us-east-1');
    expect(value.STORAGE_BUCKET).toBe('streamtube-videos');
    expect(value.REDIS_HOST).toBe('redis');
    expect(value.REDIS_PORT).toBe(6379);
    expect(value.QUEUE_PREFIX).toBe('streamtube');
    expect(value.STORAGE_PUBLIC_ENDPOINT).toBeUndefined();
  });
});

describe('storage and queue config namespaces', () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it('falls back to the internal endpoint when STORAGE_PUBLIC_ENDPOINT is unset', () => {
    process.env.STORAGE_ENDPOINT = 'http://minio:9000';
    delete process.env.STORAGE_PUBLIC_ENDPOINT;
    expect(storageConfig().publicEndpoint).toBe('http://minio:9000');
  });

  it('uses STORAGE_PUBLIC_ENDPOINT for presigning when set', () => {
    process.env.STORAGE_ENDPOINT = 'http://minio:9000';
    process.env.STORAGE_PUBLIC_ENDPOINT = 'http://localhost:9000';
    const cfg = storageConfig();
    expect(cfg.endpoint).toBe('http://minio:9000');
    expect(cfg.publicEndpoint).toBe('http://localhost:9000');
  });

  it('uses the test queue prefix inside Jest', () => {
    expect(queueConfig().prefix).toBe('streamtube-test');
  });
});
