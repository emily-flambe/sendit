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
  // Which external catalog this gym mirrors, e.g. 'kaya' + '211'. Both empty
  // when the gym has no catalog, which is the default.
  catalog_source: string;
  catalog_gym_id: string;
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
  // Provenance when the route came from a catalog import; '' when hand-entered.
  source: string;
  source_external_id: string;
}

// One climb the gym currently has set, as reported by an external platform.
// Gym climbs are typically unnamed, so grade + color + wall is the identity.
export interface CatalogEntry {
  id: string;
  source: string;
  source_gym_id: string;
  external_id: string;
  slug: string;
  grade: string;
  color: string;
  wall: string;
  discipline: Discipline;
  rating: number | null;
  ascent_count: number;
  is_closed: number;
  first_seen_at: number;
  last_seen_at: number;
  removed_at: number | null;
}

// A catalog entry annotated with whether this user already imported it.
export interface CatalogEntryWithImport extends CatalogEntry {
  imported_route_id: string | null;
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

export interface RouteWithGym extends RouteWithStats {
  gym_name: string;
}

// One logged attempt joined to its route and gym, for the climb log. The
// thumbnail fields mirror what RouteWithStats exposes for route cards.
export interface LogEntry extends Attempt {
  gym_id: string;
  gym_name: string;
  route_name: string;
  route_grade: string;
  route_color: string;
  route_discipline: Discipline;
  first_photo_id: string | null;
  image_photo_id: string | null;
  image_markers: string | null;
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

// Free-drawing annotation layer items, normalized like markers: x/y in [0,1],
// width/size as fractions of image width.
export interface DrawingStroke {
  kind: 'stroke';
  color: string; // #rrggbb
  width: number;
  points: [number, number][];
}

export interface DrawingText {
  kind: 'text';
  color: string; // #rrggbb
  size: number;
  x: number;
  y: number;
  text: string;
}

export type DrawingItem = DrawingStroke | DrawingText;

export interface RouteImage {
  route_id: string;
  photo_id: string;
  markers: RouteMarker[];
  drawings: DrawingItem[];
  updated_at: number;
}
