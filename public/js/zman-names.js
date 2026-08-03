/**
 * Single source of truth for zman display names. Style: hebrew term first,
 * clarifier in parens, always "shkia (sunset)", never bare "shkia" or
 * "sunset (shkia)".
 */
export const ZMANIM = [
  ['sunset', 'shkia (sunset)'], ['sunrise', 'neitz (sunrise)'], ['candleLighting', 'candle lighting'],
  ['havdalah', 'havdalah'], ['tzeit', 'tzeis (nightfall)'], ['chatzot', 'chatzos (midday)'],
  ['chatzotNight', 'chatzos of the night'], ['alotHaShachar', 'alos hashachar'],
  ['plagHaMincha', 'plag hamincha'], ['minchaGedola', 'mincha gedola'], ['minchaKetana', 'mincha ketana'],
  ['sofZmanShma', 'sof zman shma'], ['sofZmanTfilla', 'sof zman tefilla'],
];

const BY_ID = new Map(ZMANIM);

export function zmanLabel(id) {
  return BY_ID.get(id) ?? id;
}

/** "1h 40m before shkia (sunset)" / "at shkia (sunset)" / "30 min after havdalah" */
export function zmanOffsetLabel(zman, offsetMin) {
  const name = zmanLabel(zman);
  if (!offsetMin) return `at ${name}`;
  const abs = Math.abs(offsetMin);
  const h = Math.floor(abs / 60); const m = abs % 60;
  const span = h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m} min`;
  return `${span} ${offsetMin < 0 ? 'before' : 'after'} ${name}`;
}
