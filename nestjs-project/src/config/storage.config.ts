import { registerAs } from '@nestjs/config';

/**
 * Object storage settings (phase-03-videos/TD-02, TD-11).
 *
 * `endpoint` is the internal address used for server-side operations (Compose
 * service name). `publicEndpoint` is only used to sign URLs handed to clients:
 * the host is part of the SigV4 signature, so it must be reachable by whoever
 * uses the URL. It defaults to `endpoint` so in-network callers work unchanged.
 */
export default registerAs('storage', () => {
  const endpoint = process.env.STORAGE_ENDPOINT || 'http://minio:9000';
  return {
    endpoint,
    publicEndpoint: process.env.STORAGE_PUBLIC_ENDPOINT || endpoint,
    region: process.env.STORAGE_REGION || 'us-east-1',
    accessKey: process.env.STORAGE_ACCESS_KEY || '',
    secretKey: process.env.STORAGE_SECRET_KEY || '',
    bucket: process.env.STORAGE_BUCKET || 'streamtube-videos',
  };
});
