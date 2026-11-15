/**
 * Raised when the storage no longer knows a multipart upload (S3 `NoSuchUpload`):
 * it was completed, aborted, or purged by the storage's stale-upload expiry.
 * Internal to the storage layer — callers translate it into a domain error.
 */
export class StorageUploadNotFoundError extends Error {
  constructor(public readonly key: string) {
    super(`Multipart upload for "${key}" no longer exists in storage`);
    this.name = 'StorageUploadNotFoundError';
  }
}
