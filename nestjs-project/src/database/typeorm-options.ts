import type { ConfigType } from '@nestjs/config';
import type { TypeOrmModuleOptions } from '@nestjs/typeorm';
import databaseConfig from '../config/database.config';

/**
 * TypeORM options shared by the API (`AppModule`) and the video worker
 * (`WorkerModule`), so connection parameters come from the single
 * `databaseConfig` factory (inherited convention from phase 01).
 */
export function buildTypeOrmOptions(
  db: ConfigType<typeof databaseConfig>,
): TypeOrmModuleOptions {
  return {
    type: 'postgres',
    host: db.host,
    port: db.port,
    username: db.username,
    password: db.password,
    database: db.name,
    autoLoadEntities: true,
    synchronize: false,
  };
}
