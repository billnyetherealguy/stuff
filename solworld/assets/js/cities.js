// Offline city index used to label activity ("near Tokyo") without an API
// call per event, plus hand-tuned camera presets for the Explore shortcuts.

import { distanceM } from './geo.js';

// [name, country code, lat, lng]
const CITIES = [
  ['New York', 'US', 40.7128, -74.006], ['Los Angeles', 'US', 34.0522, -118.2437], ['Chicago', 'US', 41.8781, -87.6298],
  ['Houston', 'US', 29.7604, -95.3698], ['Phoenix', 'US', 33.4484, -112.074], ['Philadelphia', 'US', 39.9526, -75.1652],
  ['San Antonio', 'US', 29.4241, -98.4936], ['San Diego', 'US', 32.7157, -117.1611], ['Dallas', 'US', 32.7767, -96.797],
  ['Austin', 'US', 30.2672, -97.7431], ['San Francisco', 'US', 37.7749, -122.4194], ['San Jose', 'US', 37.3382, -121.8863],
  ['Seattle', 'US', 47.6062, -122.3321], ['Denver', 'US', 39.7392, -104.9903], ['Washington', 'US', 38.9072, -77.0369],
  ['Boston', 'US', 42.3601, -71.0589], ['Nashville', 'US', 36.1627, -86.7816], ['Las Vegas', 'US', 36.1699, -115.1398],
  ['Portland', 'US', 45.5152, -122.6784], ['Detroit', 'US', 42.3314, -83.0458], ['Atlanta', 'US', 33.749, -84.388],
  ['Miami', 'US', 25.7617, -80.1918], ['Minneapolis', 'US', 44.9778, -93.265], ['New Orleans', 'US', 29.9511, -90.0715],
  ['Honolulu', 'US', 21.3069, -157.8583], ['Salt Lake City', 'US', 40.7608, -111.891], ['Charlotte', 'US', 35.2271, -80.8431],
  ['Toronto', 'CA', 43.6532, -79.3832], ['Montreal', 'CA', 45.5017, -73.5673], ['Vancouver', 'CA', 49.2827, -123.1207],
  ['Calgary', 'CA', 51.0447, -114.0719], ['Ottawa', 'CA', 45.4215, -75.6972], ['Mexico City', 'MX', 19.4326, -99.1332],
  ['Guadalajara', 'MX', 20.6597, -103.3496], ['Monterrey', 'MX', 25.6866, -100.3161], ['Cancún', 'MX', 21.1619, -86.8515],
  ['Havana', 'CU', 23.1136, -82.3666], ['Panama City', 'PA', 8.9824, -79.5199], ['Bogotá', 'CO', 4.711, -74.0721],
  ['Medellín', 'CO', 6.2442, -75.5812], ['Lima', 'PE', -12.0464, -77.0428], ['Quito', 'EC', -0.1807, -78.4678],
  ['Caracas', 'VE', 10.4806, -66.9036], ['Santiago', 'CL', -33.4489, -70.6693], ['Buenos Aires', 'AR', -34.6037, -58.3816],
  ['São Paulo', 'BR', -23.5505, -46.6333], ['Rio de Janeiro', 'BR', -22.9068, -43.1729], ['Brasília', 'BR', -15.7939, -47.8828],
  ['Montevideo', 'UY', -34.9011, -56.1645], ['London', 'GB', 51.5074, -0.1278], ['Manchester', 'GB', 53.4808, -2.2426],
  ['Edinburgh', 'GB', 55.9533, -3.1883], ['Dublin', 'IE', 53.3498, -6.2603], ['Paris', 'FR', 48.8566, 2.3522],
  ['Marseille', 'FR', 43.2965, 5.3698], ['Lyon', 'FR', 45.764, 4.8357], ['Nice', 'FR', 43.7102, 7.262],
  ['Monaco', 'MC', 43.7384, 7.4246], ['Brussels', 'BE', 50.8503, 4.3517], ['Amsterdam', 'NL', 52.3676, 4.9041],
  ['Rotterdam', 'NL', 51.9244, 4.4777], ['Berlin', 'DE', 52.52, 13.405], ['Hamburg', 'DE', 53.5511, 9.9937],
  ['Munich', 'DE', 48.1351, 11.582], ['Frankfurt', 'DE', 50.1109, 8.6821], ['Cologne', 'DE', 50.9375, 6.9603],
  ['Zurich', 'CH', 47.3769, 8.5417], ['Geneva', 'CH', 46.2044, 6.1432], ['Vienna', 'AT', 48.2082, 16.3738],
  ['Prague', 'CZ', 50.0755, 14.4378], ['Warsaw', 'PL', 52.2297, 21.0122], ['Kraków', 'PL', 50.0647, 19.945],
  ['Budapest', 'HU', 47.4979, 19.0402], ['Copenhagen', 'DK', 55.6761, 12.5683], ['Stockholm', 'SE', 59.3293, 18.0686],
  ['Oslo', 'NO', 59.9139, 10.7522], ['Helsinki', 'FI', 60.1699, 24.9384], ['Reykjavík', 'IS', 64.1466, -21.9426],
  ['Madrid', 'ES', 40.4168, -3.7038], ['Barcelona', 'ES', 41.3874, 2.1686], ['Valencia', 'ES', 39.4699, -0.3763],
  ['Seville', 'ES', 37.3891, -5.9845], ['Lisbon', 'PT', 38.7223, -9.1393], ['Porto', 'PT', 41.1579, -8.6291],
  ['Rome', 'IT', 41.9028, 12.4964], ['Milan', 'IT', 45.4642, 9.19], ['Naples', 'IT', 40.8518, 14.2681],
  ['Venice', 'IT', 45.4408, 12.3155], ['Florence', 'IT', 43.7696, 11.2558], ['Athens', 'GR', 37.9838, 23.7275],
  ['Istanbul', 'TR', 41.0082, 28.9784], ['Ankara', 'TR', 39.9334, 32.8597], ['Bucharest', 'RO', 44.4268, 26.1025],
  ['Sofia', 'BG', 42.6977, 23.3219], ['Belgrade', 'RS', 44.7866, 20.4489], ['Kyiv', 'UA', 50.4501, 30.5234],
  ['Moscow', 'RU', 55.7558, 37.6173], ['Saint Petersburg', 'RU', 59.9311, 30.3609], ['Tbilisi', 'GE', 41.7151, 44.8271],
  ['Dubai', 'AE', 25.2048, 55.2708], ['Abu Dhabi', 'AE', 24.4539, 54.3773], ['Doha', 'QA', 25.2854, 51.531],
  ['Riyadh', 'SA', 24.7136, 46.6753], ['Jeddah', 'SA', 21.4858, 39.1925], ['Kuwait City', 'KW', 29.3759, 47.9774],
  ['Manama', 'BH', 26.2285, 50.586], ['Muscat', 'OM', 23.588, 58.3829], ['Tel Aviv', 'IL', 32.0853, 34.7818],
  ['Jerusalem', 'IL', 31.7683, 35.2137], ['Amman', 'JO', 31.9454, 35.9284], ['Beirut', 'LB', 33.8938, 35.5018],
  ['Tehran', 'IR', 35.6892, 51.389], ['Cairo', 'EG', 30.0444, 31.2357], ['Casablanca', 'MA', 33.5731, -7.5898],
  ['Marrakesh', 'MA', 31.6295, -7.9811], ['Tunis', 'TN', 36.8065, 10.1815], ['Lagos', 'NG', 6.5244, 3.3792],
  ['Accra', 'GH', 5.6037, -0.187], ['Nairobi', 'KE', -1.2921, 36.8219], ['Addis Ababa', 'ET', 8.9806, 38.7578],
  ['Johannesburg', 'ZA', -26.2041, 28.0473], ['Cape Town', 'ZA', -33.9249, 18.4241], ['Dakar', 'SN', 14.7167, -17.4677],
  ['Kinshasa', 'CD', -4.4419, 15.2663], ['Luanda', 'AO', -8.839, 13.2894], ['Karachi', 'PK', 24.8607, 67.0011],
  ['Lahore', 'PK', 31.5204, 74.3587], ['Delhi', 'IN', 28.6139, 77.209], ['Mumbai', 'IN', 19.076, 72.8777],
  ['Bengaluru', 'IN', 12.9716, 77.5946], ['Hyderabad', 'IN', 17.385, 78.4867], ['Chennai', 'IN', 13.0827, 80.2707],
  ['Kolkata', 'IN', 22.5726, 88.3639], ['Agra', 'IN', 27.1767, 78.0081], ['Dhaka', 'BD', 23.8103, 90.4125],
  ['Kathmandu', 'NP', 27.7172, 85.324], ['Colombo', 'LK', 6.9271, 79.8612], ['Bangkok', 'TH', 13.7563, 100.5018],
  ['Phuket', 'TH', 7.8804, 98.3923], ['Hanoi', 'VN', 21.0278, 105.8342], ['Ho Chi Minh City', 'VN', 10.8231, 106.6297],
  ['Kuala Lumpur', 'MY', 3.139, 101.6869], ['Singapore', 'SG', 1.3521, 103.8198], ['Jakarta', 'ID', -6.2088, 106.8456],
  ['Bali', 'ID', -8.6705, 115.2126], ['Manila', 'PH', 14.5995, 120.9842], ['Hong Kong', 'HK', 22.3193, 114.1694],
  ['Macau', 'MO', 22.1987, 113.5439], ['Shenzhen', 'CN', 22.5431, 114.0579], ['Guangzhou', 'CN', 23.1291, 113.2644],
  ['Shanghai', 'CN', 31.2304, 121.4737], ['Beijing', 'CN', 39.9042, 116.4074], ['Chengdu', 'CN', 30.5728, 104.0668],
  ['Wuhan', 'CN', 30.5928, 114.3055], ['Xi’an', 'CN', 34.3416, 108.9398], ['Taipei', 'TW', 25.033, 121.5654],
  ['Seoul', 'KR', 37.5665, 126.978], ['Busan', 'KR', 35.1796, 129.0756], ['Tokyo', 'JP', 35.6762, 139.6503],
  ['Yokohama', 'JP', 35.4437, 139.638], ['Osaka', 'JP', 34.6937, 135.5023], ['Kyoto', 'JP', 35.0116, 135.7681],
  ['Sapporo', 'JP', 43.0618, 141.3545], ['Fukuoka', 'JP', 33.5904, 130.4017], ['Ulaanbaatar', 'MN', 47.8864, 106.9057],
  ['Almaty', 'KZ', 43.222, 76.8512], ['Tashkent', 'UZ', 41.2995, 69.2401], ['Sydney', 'AU', -33.8688, 151.2093],
  ['Melbourne', 'AU', -37.8136, 144.9631], ['Brisbane', 'AU', -27.4698, 153.0251], ['Perth', 'AU', -31.9505, 115.8605],
  ['Adelaide', 'AU', -34.9285, 138.6007], ['Gold Coast', 'AU', -28.0167, 153.4], ['Auckland', 'NZ', -36.8485, 174.7633],
  ['Wellington', 'NZ', -41.2865, 174.7762],
];

// Global hubs weigh more when pricing ("busier places are worth more").
const HUBS = new Set([
  'New York', 'Los Angeles', 'San Francisco', 'Chicago', 'Miami', 'Las Vegas', 'Toronto', 'London', 'Paris', 'Monaco',
  'Dubai', 'Abu Dhabi', 'Doha', 'Singapore', 'Hong Kong', 'Shanghai', 'Beijing', 'Shenzhen', 'Tokyo', 'Osaka', 'Seoul',
  'Sydney', 'Mumbai', 'Moscow', 'Istanbul', 'Rome', 'Milan', 'Madrid', 'Barcelona', 'Berlin', 'Amsterdam', 'Zurich',
  'São Paulo', 'Mexico City', 'Buenos Aires', 'Bangkok', 'Taipei', 'Kuala Lumpur', 'Riyadh', 'Tel Aviv', 'Venice',
]);

/**
 * How busy a spot is: 1 in the countryside, rising towards city centers
 * (roughly 40 in the heart of a global hub, 20 in other big cities).
 * Returns { factor, city }.
 */
export function busyness(lat, lng) {
  let best = { factor: 1, city: null };
  for (const [name, , clat, clng] of CITIES) {
    if (Math.abs(clat - lat) > 1.5 || Math.abs(clng - lng) > 2) continue;
    const km = distanceM([lng, lat], [clng, clat]) / 1000;
    const weight = HUBS.has(name) ? 3 : 1.5;
    const factor = 1 + weight * 12 * Math.exp(-km / 3) + weight * 2 * Math.exp(-km / 25);
    if (factor > best.factor) best = { factor, city: name, km };
  }
  return best;
}

/** Nearest known city within `maxKm`, e.g. { name: 'Tokyo', cc: 'JP', km: 3.2 }. */
export function nearestCity(lat, lng, maxKm = 80) {
  let best = null;
  for (const [name, cc, clat, clng] of CITIES) {
    if (Math.abs(clat - lat) > 2 || Math.abs(clng - lng) > 3) continue;
    const km = distanceM([lng, lat], [clng, clat]) / 1000;
    if (km <= maxKm && (!best || km < best.km)) best = { name, cc, km };
  }
  return best;
}

export function placeLabel(lat, lng) {
  const city = nearestCity(lat, lng);
  if (city) return city.name;
  return `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(2)}°${lng >= 0 ? 'E' : 'W'}`;
}

// Hand-tuned hero shots for the Explore shortcuts.
export const FEATURED = [
  { id: 'nyc', name: 'New York', sub: 'Midtown Manhattan', center: [-73.9862, 40.7505], zoom: 15.7, pitch: 64, bearing: 29 },
  { id: 'dubai', name: 'Dubai', sub: 'Downtown', center: [55.2744, 25.1955], zoom: 15.6, pitch: 64, bearing: -32 },
  { id: 'tokyo', name: 'Tokyo', sub: 'Shinjuku', center: [139.6947, 35.6905], zoom: 15.7, pitch: 62, bearing: 24 },
  { id: 'london', name: 'London', sub: 'The City', center: [-0.0845, 51.5135], zoom: 15.8, pitch: 62, bearing: -18 },
  { id: 'paris', name: 'Paris', sub: 'Champ de Mars', center: [2.2945, 48.8566], zoom: 15.4, pitch: 60, bearing: 128 },
  { id: 'hongkong', name: 'Hong Kong', sub: 'Central', center: [114.1595, 22.2805], zoom: 15.6, pitch: 64, bearing: 8 },
  { id: 'singapore', name: 'Singapore', sub: 'Marina Bay', center: [103.856, 1.2835], zoom: 15.6, pitch: 62, bearing: -12 },
  { id: 'sf', name: 'San Francisco', sub: 'Financial District', center: [-122.3995, 37.7915], zoom: 15.8, pitch: 62, bearing: 42 },
  { id: 'chicago', name: 'Chicago', sub: 'The Loop', center: [-87.6305, 41.8815], zoom: 15.7, pitch: 64, bearing: -4 },
  { id: 'shanghai', name: 'Shanghai', sub: 'Lujiazui', center: [121.5045, 31.2375], zoom: 15.6, pitch: 62, bearing: -30 },
  { id: 'sydney', name: 'Sydney', sub: 'Circular Quay', center: [151.2111, -33.8615], zoom: 15.6, pitch: 62, bearing: 20 },
  { id: 'miami', name: 'Miami', sub: 'Brickell', center: [-80.1925, 25.7655], zoom: 15.7, pitch: 62, bearing: 8 },
];
