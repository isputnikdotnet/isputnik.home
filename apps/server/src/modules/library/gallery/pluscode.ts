// Plus Codes (Open Location Code) for the gallery's place search.
//
// Copying a location out of Google Maps hands you something like
// "8MW8+4JV, Norman Manley Blvd, Negril, Jamaica". Nominatim — the place lookup
// behind the search box — has never heard of that leading code and answers with
// nothing at all, which reads as "your address doesn't exist" for what is in fact
// the most precise part of it. So the codes are decoded here, in arithmetic, with
// no service to call.
//
// A code is a grid reference, not a name: the first pair of characters picks a
// 20°x20° square, each following pair divides it by 20, and characters after the
// tenth refine it on a 4x5 grid. Two forms turn up:
//
//   full   "76XR8MW8+4JV"      stands alone — 8 characters before the '+'.
//   short  "8MW8+4JV"          the leading characters are dropped because the
//                              town is written next to it. Meaningless on its
//                              own, so the rest of the address is geocoded first
//                              and the code is recovered against that point.
//
// This is the reference algorithm (github.com/google/open-location-code)
// transcribed, not an approximation — the constants and the integer arithmetic
// are what keep a decoded point on the same square metre Google shows.
const ALPHABET = "23456789CFGHJMPQRVWX";
const BASE = 20;
const SEPARATOR = "+";
const SEPARATOR_POSITION = 8;
const PADDING = "0";
const MAX_DIGITS = 15;
const PAIR_LENGTH = 10;
const PAIR_PRECISION = BASE ** 3;
const GRID_LENGTH = MAX_DIGITS - PAIR_LENGTH;
const GRID_COLUMNS = 4;
const GRID_ROWS = 5;
const FINAL_LAT_PRECISION = PAIR_PRECISION * GRID_ROWS ** GRID_LENGTH;
const FINAL_LNG_PRECISION = PAIR_PRECISION * GRID_COLUMNS ** GRID_LENGTH;
const LAT_MAX = 90;
const LNG_MAX = 180;

export interface PlusPoint {
  lat: number;
  lng: number;
}

const clipLat = (lat: number): number => Math.min(LAT_MAX, Math.max(-LAT_MAX, lat));

function normaliseLng(lng: number): number {
  let value = lng;
  while (value < -LNG_MAX) value += 360;
  while (value >= LNG_MAX) value -= 360;
  return value;
}

// Strip the separator and any '0' padding, leaving just the significant digits.
function digitsOf(code: string): string {
  return code.toUpperCase().replace(/\+/g, "").replace(/0+$/, "");
}

// The centre of the square a code names. Everything is accumulated in integer
// units of the finest precision and divided once at the end, so a fifteen-digit
// code doesn't drift on floating point the way successive division would.
export function decodePlusCode(code: string): PlusPoint | null {
  const digits = digitsOf(code);
  // Only the pair section has to come in twos; the grid characters past the tenth
  // stand alone, so a valid code can be an odd number of characters long.
  const pairDigits = Math.min(digits.length, PAIR_LENGTH);
  if (digits.length < 2 || pairDigits % 2 === 1) return null;
  if ([...digits].some((ch) => !ALPHABET.includes(ch))) return null;

  let normalLat = -LAT_MAX * PAIR_PRECISION;
  let normalLng = -LNG_MAX * PAIR_PRECISION;
  let extraLat = 0;
  let extraLng = 0;

  let place = BASE ** (PAIR_LENGTH / 2 - 1);
  let digit = 0;
  while (digit < pairDigits) {
    normalLat += ALPHABET.indexOf(digits[digit]) * place;
    normalLng += ALPHABET.indexOf(digits[digit + 1]) * place;
    // Divided only while another pair follows, so `place` is left holding the
    // last pair's value — which IS the size of the square a short code names.
    if (digit < pairDigits - 2) place /= BASE;
    digit += 2;
  }

  // The size of the square, needed to move from its corner to its centre.
  let latSize = place / PAIR_PRECISION;
  let lngSize = place / PAIR_PRECISION;

  if (digits.length > PAIR_LENGTH) {
    let rowPlace = GRID_ROWS ** (GRID_LENGTH - 1);
    let colPlace = GRID_COLUMNS ** (GRID_LENGTH - 1);
    const end = Math.min(digits.length, MAX_DIGITS);
    for (digit = PAIR_LENGTH; digit < end; digit += 1) {
      const value = ALPHABET.indexOf(digits[digit]);
      extraLat += Math.floor(value / GRID_COLUMNS) * rowPlace;
      extraLng += (value % GRID_COLUMNS) * colPlace;
      if (digit < end - 1) { rowPlace /= GRID_ROWS; colPlace /= GRID_COLUMNS; }
    }
    latSize = rowPlace / FINAL_LAT_PRECISION;
    lngSize = colPlace / FINAL_LNG_PRECISION;
  }

  const lat = normalLat / PAIR_PRECISION + extraLat / FINAL_LAT_PRECISION;
  const lng = normalLng / PAIR_PRECISION + extraLng / FINAL_LNG_PRECISION;
  const point = { lat: clipLat(lat + latSize / 2), lng: normaliseLng(lng + lngSize / 2) };
  return Number.isFinite(point.lat) && Number.isFinite(point.lng) ? point : null;
}

// Encode to the ten pair characters. The 4x5 grid characters that would follow
// are deliberately not produced: the only caller needs a PREFIX (the leading
// characters a short code is missing), which never reaches past the tenth.
function encodePairs(lat: number, lng: number): string {
  const latitude = clipLat(lat) === LAT_MAX ? LAT_MAX - 1e-9 : clipLat(lat);
  const longitude = normaliseLng(lng);

  // Rounded before flooring: (latitude + 90) * 8000 lands on values like
  // 863999.9999999999 for exact inputs, which would floor into the square below.
  let latValue = Math.floor(Math.round((latitude + LAT_MAX) * PAIR_PRECISION * 1e6) / 1e6);
  let lngValue = Math.floor(Math.round((longitude + LNG_MAX) * PAIR_PRECISION * 1e6) / 1e6);

  let code = "";
  for (let i = 0; i < PAIR_LENGTH / 2; i += 1) {
    code = ALPHABET.charAt(lngValue % BASE) + code;
    code = ALPHABET.charAt(latValue % BASE) + code;
    latValue = Math.floor(latValue / BASE);
    lngValue = Math.floor(lngValue / BASE);
  }
  return code;
}

// Rebuild a short code around a reference point — the town or street written
// beside it, already geocoded.
//
// The missing characters are taken from the reference's own code, which puts the
// result in the reference's square. That square is up to a degree across, so the
// naive answer can be on the wrong side of it: if the recovered point is more
// than half a square away from the reference, the neighbouring square is the
// nearer one and the answer moves by exactly one square.
export function recoverPlusCode(shortCode: string, reference: PlusPoint): PlusPoint | null {
  const code = shortCode.toUpperCase();
  const separator = code.indexOf(SEPARATOR);
  if (separator < 0 || separator >= SEPARATOR_POSITION || separator % 2 === 1) return null;

  const missing = SEPARATOR_POSITION - separator;
  const resolution = BASE ** (2 - missing / 2);
  const half = resolution / 2;

  const refLat = clipLat(reference.lat);
  const refLng = normaliseLng(reference.lng);
  const area = decodePlusCode(encodePairs(refLat, refLng).slice(0, missing) + code);
  if (!area) return null;

  let { lat, lng } = area;
  if (refLat + half < lat && lat - resolution >= -LAT_MAX) lat -= resolution;
  else if (refLat - half > lat && lat + resolution <= LAT_MAX) lat += resolution;
  if (refLng + half < lng) lng -= resolution;
  else if (refLng - half > lng) lng += resolution;

  return { lat: clipLat(lat), lng: normaliseLng(lng) };
}

export interface PlusCodeQuery {
  /** The code as typed, upper-cased. */
  code: string;
  /** True when it stands alone; false when it needs a place to anchor it. */
  full: boolean;
  /** Whatever else was in the query — the address that anchors a short code. */
  rest: string;
}

// A code anywhere in the query, with the rest of the address kept separate.
// Google writes them at the front ("8MW8+4JV, Norman Manley Blvd, Negril"), but
// people paste them at the end too, and either way the surrounding text is what
// makes a short code resolvable.
// '0' is allowed before the '+' only: it is the padding a region-sized code
// carries ("7FG40000+"), never a digit.
const CODE_PATTERN = /(?:^|[\s,;])([23456789CFGHJMPQRVWX0]{2,8}\+[23456789CFGHJMPQRVWX]{0,7})(?=$|[\s,;])/i;

export function parsePlusCode(query: string): PlusCodeQuery | null {
  const match = CODE_PATTERN.exec(query);
  if (!match) return null;

  const code = match[1].toUpperCase();
  const separator = code.indexOf(SEPARATOR);
  // Odd numbers of characters can't be pairs, and the part after the '+' is at
  // least two characters on any real code.
  if (separator % 2 === 1) return null;
  const tail = code.length - separator - 1;
  if (tail === 1) return null;

  const full = separator === SEPARATOR_POSITION;
  if (!full && separator < 2) return null;
  // Padding is a run of '0' immediately before the '+' of a full code, and
  // nothing else — "7FG40000+" is a region, "8M0W+4JV" is a typo.
  if (code.includes(PADDING) && (!full || !/^[^0]+0+\+$/.test(code))) return null;
  if (full && !decodePlusCode(code)) return null;

  // The rest of the address goes to the geocoder as written, commas and all —
  // "Norman Manley Blvd, Negril, Jamaica" is a stronger query than the same words
  // run together. Only the punctuation the code left behind is tidied.
  const rest = (query.slice(0, match.index) + ", " + query.slice(match.index + match[0].length))
    .replace(/\s+/g, " ")
    .replace(/\s*[,;]\s*(?=[,;])/g, "")
    .replace(/^[\s,;]+|[\s,;]+$/g, "");
  return { code, full, rest };
}
