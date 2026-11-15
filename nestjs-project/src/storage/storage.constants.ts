/** DI token for the S3 client used for server-side operations (internal endpoint). */
export const STORAGE_INTERNAL_CLIENT = Symbol('STORAGE_INTERNAL_CLIENT');

/** DI token for the S3 client used only to presign client-facing URLs (public endpoint). */
export const STORAGE_PRESIGN_CLIENT = Symbol('STORAGE_PRESIGN_CLIENT');
