import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsInt,
  Min,
} from 'class-validator';
import { MAX_PARTS_PER_REQUEST } from '../videos.constants';

export class PresignPartsDto {
  /** Part numbers (1-based) to receive presigned upload URLs for. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PARTS_PER_REQUEST)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  partNumbers: number[];
}
