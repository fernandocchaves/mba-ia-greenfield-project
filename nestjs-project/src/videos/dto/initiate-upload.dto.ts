import { Transform } from 'class-transformer';
import {
  IsInt,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class InitiateUploadDto {
  /** Video title shown to viewers. */
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  title: string;

  /** Original filename, used as the download name. */
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  filename: string;

  /** MIME type of the file; must be a `video/*` type. */
  @IsString()
  @Matches(/^video\/[\w.+-]+$/, {
    message: 'contentType must be a video/* MIME type',
  })
  contentType: string;

  /** Declared file size in bytes (the 10 GiB limit is enforced by the service → 413). */
  @IsInt()
  @Min(1)
  sizeBytes: number;
}
