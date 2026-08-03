import zipcodes from 'zipcodes';
import tzlookup from 'tz-lookup';

/**
 * Offline US zip code lookup: zip -> lat/lng/city/state/tzid.
 * No network access — the `zipcodes` package bundles the dataset and
 * tz-lookup resolves the IANA timezone from coordinates.
 */
export class ZipDatabase {
  lookup(zip) {
    const hit = zipcodes.lookup(String(zip).trim());
    if (!hit) return null;
    return {
      zip: hit.zip,
      lat: hit.latitude,
      lng: hit.longitude,
      city: hit.city,
      state: hit.state,
      tzid: tzlookup(hit.latitude, hit.longitude),
    };
  }
}
