import { XMLParser } from 'fast-xml-parser';

const MAX_GPX_BYTES = 5 * 1024 * 1024;
const ELEVATION_SMOOTH_WINDOW = 7; // points; reduces GPS noise before summing gain

export interface GpxParseResult {
  distanceKm: number;
  elevationGainM: number;
  pointCount: number;
}

interface TrackPoint {
  lat: number;
  lon: number;
  ele: number | null;
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function smoothedElevationGain(elevations: number[]): number {
  if (elevations.length < 2) return 0;
  const half = Math.floor(ELEVATION_SMOOTH_WINDOW / 2);
  const smoothed = elevations.map((_, i) => {
    const start = Math.max(0, i - half);
    const end = Math.min(elevations.length, i + half + 1);
    const slice = elevations.slice(start, end);
    return slice.reduce((a, b) => a + b, 0) / slice.length;
  });
  let gain = 0;
  for (let i = 1; i < smoothed.length; i++) {
    const delta = smoothed[i] - smoothed[i - 1];
    if (delta > 0) gain += delta;
  }
  return gain;
}

export function parseGpxBuffer(buffer: Buffer): GpxParseResult {
  if (buffer.length > MAX_GPX_BYTES) {
    throw new Error('GPX file exceeds 5 MB limit');
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (name) => ['trk', 'trkseg', 'trkpt'].includes(name),
    parseAttributeValue: true,
    parseTagValue: true,
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let root: any;
  try {
    root = parser.parse(buffer.toString('utf-8'));
  } catch {
    throw new Error('Invalid GPX: XML parse failed');
  }

  const gpx = root?.gpx;
  if (!gpx) throw new Error('Invalid GPX: missing <gpx> root element');

  const points: TrackPoint[] = [];
  const tracks: unknown[] = Array.isArray(gpx.trk) ? gpx.trk : gpx.trk ? [gpx.trk] : [];

  for (const trk of tracks) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = trk as any;
    const segs: unknown[] = Array.isArray(t.trkseg) ? t.trkseg : t.trkseg ? [t.trkseg] : [];
    for (const seg of segs) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const s = seg as any;
      const trkpts: unknown[] = Array.isArray(s.trkpt) ? s.trkpt : s.trkpt ? [s.trkpt] : [];
      for (const pt of trkpts) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const p = pt as any;
        const lat = Number(p['@_lat']);
        const lon = Number(p['@_lon']);
        if (!isFinite(lat) || !isFinite(lon)) continue;
        const ele = p.ele != null ? Number(p.ele) : null;
        points.push({ lat, lon, ele: ele != null && isFinite(ele) ? ele : null });
      }
    }
  }

  if (points.length < 2) {
    throw new Error('GPX contains fewer than 2 valid track points');
  }

  let distanceKm = 0;
  for (let i = 1; i < points.length; i++) {
    distanceKm += haversineKm(
      points[i - 1].lat, points[i - 1].lon,
      points[i].lat, points[i].lon,
    );
  }

  const elevations = points.map((p) => p.ele).filter((e): e is number => e !== null);
  const elevationGainM = smoothedElevationGain(elevations);

  return {
    distanceKm: Math.round(distanceKm * 100) / 100,
    elevationGainM: Math.round(elevationGainM),
    pointCount: points.length,
  };
}
