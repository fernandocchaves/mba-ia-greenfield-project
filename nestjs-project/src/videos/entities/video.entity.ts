import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';

/** Video lifecycle (phase-03-videos/TD-10, TD-12). */
export enum VideoStatus {
  DRAFT = 'draft',
  PROCESSING = 'processing',
  READY = 'ready',
  FAILED = 'failed',
}

export interface VideoMetadata {
  formatName: string | null;
  bitRate: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  frameRate: number | null;
}

/** Postgres returns bigint/numeric as strings; map them to JS numbers. */
const numericTransformer = {
  to: (value: number | null | undefined) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

@Entity('videos')
@Index('IDX_videos_status_created_at', ['status', 'created_at'])
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Public, URL-safe identifier — 11-char base64url (phase-03-videos/TD-07). */
  @Column({ type: 'varchar', length: 11, unique: true })
  url_id: string;

  @Index('IDX_videos_channel_id')
  @Column({ type: 'uuid' })
  channel_id: string;

  @ManyToOne(() => Channel, (channel) => channel.videos, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;

  @Column({ type: 'varchar', length: 100 })
  title: string;

  @Column({
    type: 'enum',
    enum: VideoStatus,
    enumName: 'videos_status_enum',
    default: VideoStatus.DRAFT,
  })
  status: VideoStatus;

  @Column({ type: 'varchar', length: 255 })
  original_filename: string;

  @Column({ type: 'varchar', length: 127 })
  content_type: string;

  /** Declared size in bytes; ≤ 10 GiB (phase-03-videos/TD-04). */
  @Column({ type: 'bigint', transformer: numericTransformer })
  size_bytes: number;

  /** `videos/{id}/source` (phase-03-videos/TD-02). */
  @Column({ type: 'varchar', length: 255 })
  storage_key: string;

  /** S3 multipart UploadId while `draft`; null afterwards. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  upload_id: string | null;

  /** `videos/{id}/thumbnail.jpg` once processed. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  thumbnail_key: string | null;

  @Column({
    name: 'duration_seconds',
    type: 'numeric',
    precision: 12,
    scale: 3,
    nullable: true,
    transformer: numericTransformer,
  })
  duration_seconds: number | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: VideoMetadata | null;

  @Column({ type: 'text', nullable: true })
  processing_error: string | null;

  @Column({ type: 'timestamp', nullable: true })
  processed_at: Date | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;
}
