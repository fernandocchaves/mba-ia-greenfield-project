import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import * as argon2 from 'argon2';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { AppModule } from '../../src/app.module';
import { ChannelsService } from '../../src/channels/channels.service';
import { DomainExceptionFilter } from '../../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../../src/common/filters/validation-exception.filter';
import { User } from '../../src/users/entities/user.entity';

/** Boots the full application with the same global pipes/filters as `main.ts`. */
export async function createVideoTestApp(): Promise<INestApplication<App>> {
  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(
    new DomainExceptionFilter(),
    new ValidationExceptionFilter(),
  );
  await app.init();
  return app;
}

export function clearThrottling(app: INestApplication<App>): void {
  app.get<ThrottlerStorageService>(ThrottlerStorage).storage.clear();
}

/**
 * Creates a confirmed user with a channel directly in the database and logs in
 * through the real `/auth/login` endpoint. Returns the bearer access token.
 */
export async function createUserAndLogin(
  app: INestApplication<App>,
  email: string,
  password = 'password123',
): Promise<string> {
  const dataSource = app.get(DataSource);
  const user = await dataSource.getRepository(User).save({
    email,
    password: await argon2.hash(password),
    is_confirmed: true,
  });
  await app.get(ChannelsService).createChannel(user.id, email);

  const res = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email, password })
    .expect(200);
  return (res.body as { access_token: string }).access_token;
}

export interface ErrorBody {
  statusCode: number;
  error: string;
}

export const validUploadBody = {
  title: 'My first video',
  filename: 'first.mp4',
  contentType: 'video/mp4',
  sizeBytes: 12,
};

/** `POST /videos` as the given user (returns the supertest request). */
export function startUpload(
  app: INestApplication<App>,
  token: string,
  body: Record<string, unknown> = validUploadBody,
) {
  return request(app.getHttpServer())
    .post('/videos')
    .set('Authorization', `Bearer ${token}`)
    .send(body);
}

/** Presigns part 1 and PUTs `body` straight to storage (single-part upload). */
export async function uploadSinglePart(
  app: INestApplication<App>,
  token: string,
  urlId: string,
  body: Buffer,
): Promise<number> {
  const res = await request(app.getHttpServer())
    .post(`/videos/${urlId}/upload/parts`)
    .set('Authorization', `Bearer ${token}`)
    .send({ partNumbers: [1] })
    .expect(200);
  const { parts } = res.body as { parts: { url: string }[] };
  const put = await fetch(parts[0].url, {
    method: 'PUT',
    body: new Uint8Array(body),
  });
  return put.status;
}
