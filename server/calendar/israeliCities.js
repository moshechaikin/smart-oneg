/**
 * Curated list of major Israeli cities → coordinates, for Israel mode where a
 * US zip lookup makes no sense. City-center points are precise enough for
 * zmanim (they shift by only seconds across a town); users can still fine-tune
 * exact lat/long in Settings. Elevation is included where it materially affects
 * shkia (hill cities like Jerusalem, Tzfat). All use Asia/Jerusalem, il = true.
 *
 * `candleMins` is an optional local minhag hint (Jerusalem lights 40 min before
 * shkia); omitted means "use the user's configured default".
 */
export const ISRAELI_CITIES = [
  { name: 'Jerusalem', he: 'ירושלים', lat: 31.76904, lng: 35.21633, elevation: 754, candleMins: 40 },
  { name: 'Tel Aviv', he: 'תל אביב', lat: 32.08088, lng: 34.78057, elevation: 5 },
  { name: 'Haifa', he: 'חיפה', lat: 32.81841, lng: 34.98850, elevation: 300 },
  { name: 'Bnei Brak', he: 'בני ברק', lat: 32.08074, lng: 34.83380, elevation: 20 },
  { name: 'Beit Shemesh', he: 'בית שמש', lat: 31.74875, lng: 34.98836, elevation: 300 },
  { name: 'Modiin Illit', he: 'מודיעין עילית', lat: 31.93250, lng: 35.04130, elevation: 300 },
  { name: 'Beitar Illit', he: 'ביתר עילית', lat: 31.69610, lng: 35.11730, elevation: 800 },
  { name: 'Ashdod', he: 'אשדוד', lat: 31.80400, lng: 34.65517, elevation: 15 },
  { name: 'Petach Tikvah', he: 'פתח תקווה', lat: 32.08707, lng: 34.88747, elevation: 40 },
  { name: 'Netanya', he: 'נתניה', lat: 32.32833, lng: 34.85992, elevation: 30 },
  { name: 'Rishon LeZion', he: 'ראשון לציון', lat: 31.97102, lng: 34.78939, elevation: 40 },
  { name: 'Rehovot', he: 'רחובות', lat: 31.89420, lng: 34.80878, elevation: 76 },
  { name: 'Ramat Gan', he: 'רמת גן', lat: 32.08227, lng: 34.81065, elevation: 80 },
  { name: 'Bat Yam', he: 'בת ים', lat: 32.02379, lng: 34.75185, elevation: 15 },
  { name: 'Holon', he: 'חולון', lat: 32.01034, lng: 34.77918, elevation: 25 },
  { name: 'Herzliya', he: 'הרצליה', lat: 32.16627, lng: 34.84326, elevation: 40 },
  { name: 'Kfar Saba', he: 'כפר סבא', lat: 32.17500, lng: 34.90694, elevation: 55 },
  { name: 'Modiin', he: 'מודיעין', lat: 31.89772, lng: 35.01047, elevation: 250 },
  { name: 'Beer Sheva', he: 'באר שבע', lat: 31.25181, lng: 34.79130, elevation: 260 },
  { name: 'Ashkelon', he: 'אשקלון', lat: 31.66926, lng: 34.57149, elevation: 55 },
  { name: 'Elad', he: 'אלעד', lat: 32.05236, lng: 34.95152, elevation: 130 },
  { name: 'Kiryat Gat', he: 'קרית גת', lat: 31.60998, lng: 34.76422, elevation: 130 },
  { name: 'Lod', he: 'לוד', lat: 31.95147, lng: 34.89598, elevation: 55 },
  { name: 'Ramla', he: 'רמלה', lat: 31.92923, lng: 34.86563, elevation: 75 },
  { name: 'Raanana', he: 'רעננה', lat: 32.18470, lng: 34.87122, elevation: 65 },
  { name: 'Tiberias', he: 'טבריה', lat: 32.79221, lng: 35.53124, elevation: -130 },
  { name: 'Tzfat (Safed)', he: 'צפת', lat: 32.96465, lng: 35.49600, elevation: 850 },
  { name: 'Nahariya', he: 'נהריה', lat: 33.00892, lng: 35.09895, elevation: 20 },
  { name: 'Akko (Acre)', he: 'עכו', lat: 32.92768, lng: 35.08328, elevation: 10 },
  { name: 'Karmiel', he: 'כרמיאל', lat: 32.91846, lng: 35.29517, elevation: 300 },
  { name: 'Afula', he: 'עפולה', lat: 32.60932, lng: 35.28963, elevation: 60 },
  { name: 'Nazareth', he: 'נצרת', lat: 32.70088, lng: 35.29750, elevation: 400 },
  { name: 'Eilat', he: 'אילת', lat: 29.55770, lng: 34.95199, elevation: 12 },
  { name: 'Dimona', he: 'דימונה', lat: 31.06810, lng: 35.03270, elevation: 570 },
  { name: 'Yavne', he: 'יבנה', lat: 31.87814, lng: 34.73915, elevation: 30 },
  { name: 'Hadera', he: 'חדרה', lat: 32.43403, lng: 34.91988, elevation: 30 },
  { name: 'Kiryat Shmona', he: 'קרית שמונה', lat: 33.20749, lng: 35.56979, elevation: 120 },
  { name: 'Maale Adumim', he: 'מעלה אדומים', lat: 31.77306, lng: 35.29750, elevation: 480 },
  { name: 'Givat Shmuel', he: 'גבעת שמואל', lat: 32.07806, lng: 34.85000, elevation: 40 },
  { name: 'Ariel', he: 'אריאל', lat: 32.10530, lng: 35.17390, elevation: 500 },
];

/** For a picked city, the location patch the app stores. */
export function israeliCityLocation(name) {
  const c = ISRAELI_CITIES.find((x) => x.name === name);
  if (!c) return null;
  return {
    zip: '', city: c.name, state: 'Israel',
    lat: c.lat, lng: c.lng, elevation: c.elevation ?? 0,
    tzid: 'Asia/Jerusalem', il: true,
  };
}
