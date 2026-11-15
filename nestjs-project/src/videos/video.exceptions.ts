import { DomainException } from '../common/exceptions/domain.exception';

/** Error Catalog of phase-03-videos (see docs/phases/phase-03-videos/phase-03-videos.md). */

export class VideoTooLargeException extends DomainException {
  constructor(maxBytes: number) {
    super(
      'VIDEO_TOO_LARGE',
      413,
      `Video exceeds the maximum size of ${maxBytes} bytes`,
    );
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class InvalidPartNumberException extends DomainException {
  constructor(partCount: number) {
    super(
      'INVALID_PART_NUMBER',
      400,
      `Part numbers must be between 1 and ${partCount}`,
    );
  }
}

export class VideoNotUploadableException extends DomainException {
  constructor() {
    super(
      'VIDEO_NOT_UPLOADABLE',
      409,
      'Video is not accepting uploads (it is no longer a draft)',
    );
  }
}

export class UploadIncompleteException extends DomainException {
  constructor(detail: string) {
    super('UPLOAD_INCOMPLETE', 409, `Upload is incomplete: ${detail}`);
  }
}

export class UploadExpiredException extends DomainException {
  constructor() {
    super(
      'UPLOAD_EXPIRED',
      409,
      'The multipart upload no longer exists in storage; start a new upload',
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video has not finished processing');
  }
}
