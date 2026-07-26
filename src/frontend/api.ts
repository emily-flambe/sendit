// The API returns these row shapes verbatim, so the wire types are the worker's
// types — declared once in src/types.ts and re-exported here for view code.
import type {
  Attempt,
  AttemptResult,
  CatalogEntryWithImport,
  CatalogSource,
  ClimbType,
  DrawingItem,
  Gym,
  LinkedRoute,
  LogEntry,
  Photo,
  PhotoWithLinks,
  Route,
  RouteImage,
  RouteMarker,
  RouteWithGym,
  RouteWithStats,
  User,
} from '../types';

export type {
  Attempt,
  AttemptResult,
  CatalogEntryWithImport,
  CatalogSource,
  ClimbType,
  Discipline,
  DrawingItem,
  DrawingStroke,
  DrawingText,
  Gym,
  LinkedRoute,
  LogEntry,
  Photo,
  PhotoWithLinks,
  Route,
  RouteImage,
  RouteMarker,
  RouteWithGym,
  RouteWithStats,
  User,
} from '../types';

const TOKEN_KEY = 'sendit_token';

// Client-side description of a crop/rotate edit, normalized like markers.
export interface PhotoEdit {
  rotate: 0 | 1 | 2 | 3;
  crop: { x: number; y: number; w: number; h: number };
  width: number;
  height: number;
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
  updateGym: (
    id: string,
    fields: Partial<Pick<Gym, 'name' | 'notes' | 'archived' | 'catalog_source' | 'catalog_gym_id'>>
  ) => request<{ gym: Gym }>('PATCH', `/gyms/${id}`, fields),

  listCatalogSources: () => request<{ sources: CatalogSource[] }>('GET', '/catalogs'),
  listGymCatalog: (gymId: string) =>
    request<{ catalog: CatalogEntryWithImport[] }>('GET', `/gyms/${gymId}/catalog`),
  importCatalog: (gymId: string, catalogIds: string[]) =>
    request<{ routes: Route[]; skipped: string[] }>('POST', `/gyms/${gymId}/catalog/import`, {
      catalog_ids: catalogIds,
    }),

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
  setRouteImage: (routeId: string, photoId: string, markers: RouteMarker[], drawings: DrawingItem[] = []) =>
    request<{ route_image: RouteImage }>('PUT', `/routes/${routeId}/image`, { photo_id: photoId, markers, drawings }),
  deleteRouteImage: (routeId: string) => request<{ success: boolean }>('DELETE', `/routes/${routeId}/image`),
  updateRoute: (id: string, fields: Partial<Route>) => request<{ route: Route }>('PATCH', `/routes/${id}`, fields),
  deleteRoute: (id: string) => request<{ success: boolean }>('DELETE', `/routes/${id}`),

  createAttempt: (
    routeId: string,
    fields: {
      attempted_on: string;
      result: AttemptResult;
      climb_type?: ClimbType | '';
      flashed?: number;
      high_point?: string;
      notes?: string;
    }
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
