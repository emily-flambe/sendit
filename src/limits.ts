// Annotation caps enforced by the API validators and honored by the editor UI,
// which stops adding shapes rather than letting a save fail.

export const MAX_ROUTE_IMAGE_MARKERS = 100;
export const MAX_POLYGON_POINTS = 80;
export const MAX_DRAWING_ITEMS = 200;
export const MAX_STROKE_POINTS = 500;

// Ceiling on one catalog-import request. A whole gym's inventory is a few
// hundred climbs, so this comfortably allows "import everything" in one call
// while bounding how many inserts a single request can do.
export const MAX_CATALOG_IMPORT = 500;
