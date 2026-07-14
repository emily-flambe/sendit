const TOKEN_KEY = 'sendit_token';

export interface User {
  id: string;
  username: string;
  created_at: number;
}

export interface Gym {
  id: string;
  name: string;
  notes: string;
  archived: number;
  created_at: number;
}

export type Discipline = 'boulder' | 'top_rope' | 'lead' | 'autobelay';
export type AttemptResult = 'send' | 'attempt';

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

export interface RouteWithStats extends Route {
  attempt_count: number;
  send_count: number;
  last_attempted_on: string | null;
  photo_count: number;
  first_photo_id: string | null;
}

export interface RouteWithGym extends RouteWithStats {
  gym_name: string;
}

export interface LogEntry {
  id: string;
  route_id: string;
  gym_id: string;
  attempted_on: string;
  result: AttemptResult;
  flashed: number;
  high_point: string;
  notes: string;
  created_at: number;
  route_name: string;
  route_grade: string;
  route_color: string;
  route_discipline: Discipline;
  gym_name: string;
}

export interface Photo {
  id: string;
  gym_id: string | null;
  content_type: string;
  size: number;
  created_at: number;
  updated_at: number;
}

export interface PhotoWithLinks extends Photo {
  link_count: number;
}

export interface LinkedRoute {
  route_id: string;
  name: string;
  grade: string;
  color: string;
  has_annotation: number;
}

// Client-side description of a crop/rotate edit, normalized like markers.
export interface PhotoEdit {
  rotate: 0 | 1 | 2 | 3;
  crop: { x: number; y: number; w: number; h: number };
  width: number;
  height: number;
}

export interface RouteMarker {
  x: number;
  y: number;
  r: number;
  polygon?: [number, number][];
}

export interface RouteImage {
  route_id: string;
  photo_id: string;
  markers: RouteMarker[];
  updated_at: number;
}

export interface Attempt {
  id: string;
  route_id: string;
  attempted_on: string;
  result: AttemptResult;
  flashed: number;
  high_point: string;
  notes: string;
  created_at: number;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && path !== '/auth/login') {
    setToken(null);
    window.location.hash = '#/login';
  }

  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new ApiError(res.status, typeof data.error === 'string' ? data.error : 'Something went wrong');
  }
  return data as T;
}

export const api = {
  register: (username: string, password: string) =>
    request<{ token: string; user: User }>('POST', '/auth/register', { username, password }),
  login: (username: string, password: string) =>
    request<{ token: string; user: User }>('POST', '/auth/login', { username, password }),
  me: () => request<{ user: User }>('GET', '/auth/me'),

  listGyms: (includeArchived = false) =>
    request<{ gyms: Gym[] }>('GET', `/gyms${includeArchived ? '?archived=1' : ''}`),
  createGym: (name: string, notes = '') => request<{ gym: Gym }>('POST', '/gyms', { name, notes }),
  updateGym: (id: string, fields: Partial<Pick<Gym, 'name' | 'notes' | 'archived'>>) =>
    request<{ gym: Gym }>('PATCH', `/gyms/${id}`, fields),

  listRoutes: (gymId: string, includeArchived = false) =>
    request<{ routes: RouteWithStats[] }>('GET', `/gyms/${gymId}/routes${includeArchived ? '?archived=1' : ''}`),
  listAllRoutes: (includeArchived = false) =>
    request<{ routes: RouteWithGym[] }>('GET', `/routes${includeArchived ? '?archived=1' : ''}`),
  listLog: () => request<{ entries: LogEntry[] }>('GET', '/attempts'),
  createRoute: (gymId: string, fields: Partial<Route>) =>
    request<{ route: Route }>('POST', `/gyms/${gymId}/routes`, fields),
  getRoute: (id: string) =>
    request<{ route: Route; attempts: Attempt[]; photos: Photo[]; route_image: RouteImage | null }>(
      'GET',
      `/routes/${id}`
    ),
  setRouteImage: (routeId: string, photoId: string, markers: RouteMarker[]) =>
    request<{ route_image: RouteImage }>('PUT', `/routes/${routeId}/image`, { photo_id: photoId, markers }),
  deleteRouteImage: (routeId: string) => request<{ success: boolean }>('DELETE', `/routes/${routeId}/image`),
  updateRoute: (id: string, fields: Partial<Route>) => request<{ route: Route }>('PATCH', `/routes/${id}`, fields),
  deleteRoute: (id: string) => request<{ success: boolean }>('DELETE', `/routes/${id}`),

  createAttempt: (
    routeId: string,
    fields: { attempted_on: string; result: AttemptResult; flashed?: number; high_point?: string; notes?: string }
  ) => request<{ attempt: Attempt }>('POST', `/routes/${routeId}/attempts`, fields),
  updateAttempt: (id: string, fields: Partial<Pick<Attempt, 'attempted_on' | 'result' | 'flashed' | 'high_point' | 'notes'>>) =>
    request<{ attempt: Attempt }>('PATCH', `/attempts/${id}`, fields),
  deleteAttempt: (id: string) => request<{ success: boolean }>('DELETE', `/attempts/${id}`),

  uploadBlob: async <T>(path: string, blob: Blob): Promise<T> => {
    const res = await fetch(`/api${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': blob.type },
      body: blob,
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new ApiError(res.status, typeof data.error === 'string' ? data.error : 'Upload failed');
    }
    return data as T;
  },
  uploadRoutePhoto: (routeId: string, blob: Blob) => api.uploadBlob<{ photo: Photo }>(`/routes/${routeId}/photos`, blob),
  uploadGalleryPhoto: (blob: Blob, gymId: string | null) =>
    api.uploadBlob<{ photo: Photo }>(`/photos${gymId ? `?gym=${encodeURIComponent(gymId)}` : ''}`, blob),
  editPhoto: (photoId: string, blob: Blob, edit: PhotoEdit, mode: 'overwrite' | 'new') => {
    const params = new URLSearchParams({
      mode,
      rotate: String(edit.rotate),
      crop_x: String(edit.crop.x),
      crop_y: String(edit.crop.y),
      crop_w: String(edit.crop.w),
      crop_h: String(edit.crop.h),
      width: String(edit.width),
      height: String(edit.height),
    });
    return api.uploadBlob<{ photo: Photo }>(`/photos/${photoId}/edit?${params}`, blob);
  },
  listGalleryPhotos: (gymId: string | null) =>
    request<{ photos: PhotoWithLinks[] }>('GET', `/photos${gymId ? `?gym=${encodeURIComponent(gymId)}` : ''}`),
  getPhotoInfo: (photoId: string) =>
    request<{ photo: Photo; routes: LinkedRoute[] }>('GET', `/photos/${photoId}/info`),
  updatePhotoGym: (photoId: string, gymId: string | null) =>
    request<{ photo: Photo }>('PATCH', `/photos/${photoId}`, { gym_id: gymId }),
  linkPhoto: (routeId: string, photoId: string) =>
    request<{ photo: Photo }>('PUT', `/routes/${routeId}/photos/${photoId}`),
  unlinkPhoto: (routeId: string, photoId: string) =>
    request<{ success: boolean }>('DELETE', `/routes/${routeId}/photos/${photoId}`),
  fetchPhotoBlob: async (photoId: string, version: number): Promise<Blob> => {
    const res = await fetch(`/api/photos/${photoId}?v=${version}`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) {
      throw new ApiError(res.status, 'Could not load photo');
    }
    return res.blob();
  },
  deletePhoto: (id: string) => request<{ success: boolean }>('DELETE', `/photos/${id}`),
};
