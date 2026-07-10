export interface Env {
  DB: D1Database;
  PHOTOS: R2Bucket;
  JWT_SECRET: string;
}

export type Discipline = 'boulder' | 'top_rope' | 'lead' | 'autobelay';
export type AttemptResult = 'send' | 'attempt';

export interface User {
  id: string;
  username: string;
  created_at: number;
}

export interface Gym {
  id: string;
  user_id: string;
  name: string;
  notes: string;
  archived: number;
  created_at: number;
}

export interface Route {
  id: string;
  gym_id: string;
  name: string;
  grade: string;
  color: string;
  wall: string;
  discipline: Discipline;
  notes: string;
  archived: number;
  created_at: number;
  updated_at: number;
}

export interface Attempt {
  id: string;
  route_id: string;
  attempted_on: string;
  result: AttemptResult;
  high_point: string;
  notes: string;
  created_at: number;
}

export interface RouteWithStats extends Route {
  attempt_count: number;
  send_count: number;
  last_attempted_on: string | null;
  photo_count: number;
  first_photo_id: string | null;
}

export interface RoutePhoto {
  id: string;
  route_id: string;
  r2_key: string;
  content_type: string;
  size: number;
  created_at: number;
}
