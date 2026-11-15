/** The file is not a readable video (no video stream, no duration, or ffprobe rejected it). */
export class InvalidMediaError extends Error {
  constructor(reason: string) {
    super(`Invalid media: ${reason}`);
    this.name = 'InvalidMediaError';
  }
}
