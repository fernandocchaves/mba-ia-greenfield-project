import { randomBytes } from 'node:crypto';

/** Number of random bytes behind a URL id; 8 bytes → 11 base64url chars, 64 bits of entropy. */
const URL_ID_BYTES = 8;

/**
 * Generates the public URL identifier of a video (phase-03-videos/TD-07).
 * Uniqueness is guaranteed by the `videos.url_id` unique constraint; callers
 * retry on the (negligible) collision.
 */
export function generateUrlId(): string {
  return randomBytes(URL_ID_BYTES).toString('base64url');
}
