// Where the sun is, right now, anywhere on Earth. Drives the map's lighting,
// day/night textures and which photos a building shows (standard solar
// position formulas, as used by SunCalc; accurate to a fraction of a degree).

const RAD = Math.PI / 180;
const DAY_MS = 86_400_000;
const J2000 = 2_451_545;
const OBLIQUITY = RAD * 23.4397;

const toDays = (date) => date.valueOf() / DAY_MS - 0.5 + 2_440_588 - J2000;

function sunCoords(d) {
  const M = RAD * (357.5291 + 0.98560028 * d); // mean anomaly
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + RAD * 102.9372 + Math.PI; // ecliptic longitude
  return {
    dec: Math.asin(Math.sin(OBLIQUITY) * Math.sin(L)),
    ra: Math.atan2(Math.sin(L) * Math.cos(OBLIQUITY), Math.cos(L)),
  };
}

/**
 * Sun position at `lng`/`lat` (degrees).
 * @returns { altitude (deg above horizon), bearing (deg clockwise from north), phase }
 */
export function sunPosition(lng, lat, date = new Date()) {
  const d = toDays(date);
  const { dec, ra } = sunCoords(d);
  const siderealTime = RAD * (280.16 + 360.9856235 * d) + RAD * lng;
  const H = siderealTime - ra; // hour angle
  const phi = RAD * lat;
  const altitude = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H)) / RAD;
  const azimuthFromSouth = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
  const bearing = (azimuthFromSouth / RAD + 180 + 360) % 360;
  return { altitude, bearing, phase: phaseOf(altitude) };
}

/** 'day' (sun well up), 'dusk' (sunrise/sunset glow) or 'night'. */
export function phaseOf(altitude) {
  if (altitude > 8) return 'day';
  if (altitude > -5) return 'dusk';
  return 'night';
}

export const PHASE_LABELS = { day: 'Daytime', dusk: 'Golden hour', night: 'Night' };
