// The route itself is just a boulder or a roped route. How a roped route was
// climbed (top rope / lead / auto belay) is recorded per attempt as climb_type.
export type Discipline = 'boulder' | 'route';
export type ClimbType = 'top_rope' | 'lead' | 'autobelay';
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
  climb_type: ClimbType | ''; // '' for boulders, which have no climb style
  flashed: number;
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
  image_photo_id: string | null;
  image_markers: string | null; // markers JSON of the route image, for spotlit thumbnails
  image_photo_v: number | null;
}

// Gallery photo: owned by a user, optionally tagged with a gym, linked to
// any number of routes via route_photo_links.
export interface Photo {
  id: string;
  user_id: string;
  gym_id: string | null;
  r2_key: string;
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

// Normalized to the image: x/y in [0,1], r as a fraction of image width.
// A manual tap stores just the circle (x, y, r); an auto-detected hold also
// carries `polygon` — the hold's outline as normalized [x, y] points, rendered
// as a filled silhouette. x/y/r stay the centroid + bounding radius for
// hit-testing either way.
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
