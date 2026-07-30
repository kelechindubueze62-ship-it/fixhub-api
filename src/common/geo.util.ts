// Haversine distance in km. Good enough for ranking/filtering without
// needing PostGIS. Extracted here because both the emergency-broadcast
// path (jobs.module.ts) and the assignment-shortlist path
// (contractors.module.ts) need the exact same "how far is this
// technician/company from this building" calculation — duplicating it
// would risk the two drifting to slightly different definitions of
// "nearby."
export function distanceKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLng = ((bLng - aLng) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) * Math.cos((bLat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
