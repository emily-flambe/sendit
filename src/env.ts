// Worker bindings live apart from src/types.ts so frontend code can import the
// pure data types without pulling Cloudflare globals into its typecheck.
export interface Env {
  DB: D1Database;
  PHOTOS: R2Bucket;
  JWT_SECRET: string;
}
