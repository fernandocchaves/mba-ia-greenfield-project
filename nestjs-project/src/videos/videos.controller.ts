import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { JwtPayload } from '../auth/auth.types';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { PresignPartsDto } from './dto/presign-parts.dto';
import { VideosService } from './videos.service';
import type {
  CompleteUploadResult,
  InitiateUploadResult,
  PresignedPartsResult,
} from './videos.types';

const errorSchema = { $ref: getSchemaPath(ApiErrorEnvelope) };

@ApiTags('videos')
@ApiBearerAuth('access-token')
@Controller('videos')
export class VideosController {
  constructor(private readonly videosService: VideosService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Start a video upload',
    description:
      "Pre-registers the video as a draft in the caller's channel and opens a multipart upload. The file itself is uploaded straight to object storage with presigned part URLs.",
  })
  @ApiResponse({
    status: 201,
    description: 'Draft created; upload opened',
    schema: {
      properties: {
        urlId: { type: 'string', example: 'dQw4w9WgXcQ' },
        status: { type: 'string', enum: ['draft'] },
        partSize: { type: 'integer', example: 67108864 },
        partCount: { type: 'integer', example: 160 },
        maxPartsPerRequest: { type: 'integer', example: 100 },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 413,
    description: 'Video larger than 10 GiB (VIDEO_TOO_LARGE)',
    schema: errorSchema,
  })
  initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<InitiateUploadResult> {
    return this.videosService.initiateUpload(user.sub, dto);
  }

  @Post(':urlId/upload/parts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Presign upload part URLs',
    description:
      'Returns presigned URLs to PUT each requested part directly to object storage. URLs expire after one hour; request new ones as needed.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URLs',
    schema: {
      properties: {
        parts: {
          type: 'array',
          items: {
            properties: {
              partNumber: { type: 'integer' },
              url: { type: 'string', format: 'uri' },
            },
          },
        },
        expiresAt: { type: 'string', format: 'date-time' },
      },
    },
  })
  @ApiResponse({
    status: 400,
    description:
      'Validation failed or part number out of range (INVALID_PART_NUMBER)',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found (VIDEO_NOT_FOUND)',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description: 'Video is no longer a draft (VIDEO_NOT_UPLOADABLE)',
    schema: errorSchema,
  })
  presignParts(
    @CurrentUser() user: JwtPayload,
    @Param('urlId') urlId: string,
    @Body() dto: PresignPartsDto,
  ): Promise<PresignedPartsResult> {
    return this.videosService.presignUploadParts(
      user.sub,
      urlId,
      dto.partNumbers,
    );
  }

  @Post(':urlId/upload/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Verifies the uploaded parts directly in object storage, completes the multipart upload, moves the video to `processing` and enqueues it for the video worker.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed; processing enqueued',
    schema: {
      properties: {
        urlId: { type: 'string' },
        status: { type: 'string', enum: ['processing'] },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found (VIDEO_NOT_FOUND)',
    schema: errorSchema,
  })
  @ApiResponse({
    status: 409,
    description:
      'Not a draft (VIDEO_NOT_UPLOADABLE), parts missing or size mismatch (UPLOAD_INCOMPLETE), or the multipart upload no longer exists (UPLOAD_EXPIRED)',
    schema: errorSchema,
  })
  completeUpload(
    @CurrentUser() user: JwtPayload,
    @Param('urlId') urlId: string,
  ): Promise<CompleteUploadResult> {
    return this.videosService.completeUpload(user.sub, urlId);
  }
}
