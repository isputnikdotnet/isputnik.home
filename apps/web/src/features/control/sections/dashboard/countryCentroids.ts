// Where to put a country's bubble on the Locations map.
//
// The connection data behind that map is country-granular unless a city-level
// database is in use, so a country needs one coordinate to stand at. These are
// area centroids of each country's largest landmass, computed once from the
// path data of @svg-maps/world (CC BY 4.0) and inverse-projected through a
// measured Mercator fit — see scripts/gen-country-centroids.mjs, which
// regenerates this file.
//
// They are anchors, not facts: a country made of scattered islands gets the
// biggest island, so New Zealand sits on the South Island and the United States
// on the lower 48. The map labels a bubble with the country's name and count, and
// never claims more precision than that.

export const COUNTRY_CENTROIDS: Record<string, [lat: number, lng: number]> = {
  ad: [42.57, 1.52], // Andorra
  ae: [23.95, 54.24], // United Arab Emirates
  af: [33.94, 65.97], // Afghanistan
  ag: [17.13, -61.8], // Antigua and Barbuda
  ai: [18.27, -63.07], // Anguilla
  al: [41.18, 20], // Albania
  am: [40.32, 44.86], // Armenia
  ao: [-12.28, 17.52], // Angola
  ar: [-36.21, -65.4], // Argentina
  as: [-14.19, -170.86], // American Samoa
  at: [47.62, 14.09], // Austria
  au: [-25.9, 134.33], // Australia
  aw: [12.58, -69.99], // Aruba
  ax: [60.27, 19.89], // Aland Islands
  az: [40.38, 47.6], // Azerbaijan
  ba: [44.21, 17.72], // Bosnia and Herzegovina
  bb: [13.24, -59.57], // Barbados
  bd: [23.95, 90.13], // Bangladesh
  be: [50.68, 4.59], // Belgium
  bf: [12.34, -1.79], // Burkina Faso
  bg: [42.81, 25.16], // Bulgaria
  bh: [26.08, 50.47], // Bahrain
  bi: [-3.26, 29.82], // Burundi
  bj: [9.72, 2.29], // Benin
  bl: [17.95, -62.85], // Saint Barthelemy
  bm: [32.34, -64.76], // Bermuda
  bn: [4.57, 114.49], // Brunei Darussalam
  bo: [-16.66, -64.69], // Bolivia
  bq: [12.24, -68.28], // Bonaire,  Saint Eustachius and Saba
  br: [-11.13, -53.06], // Brazil
  bs: [24.74, -78.04], // Bahamas
  bt: [27.45, 90.31], // Bhutan
  bv: [-54.35, 3.37], // Bouvet Island
  bw: [-22.11, 23.74], // Botswana
  by: [53.61, 27.99], // Belarus
  bz: [17.25, -88.71], // Belize
  ca: [59.88, -104.25], // Canada
  cc: [-12.05, 96.75], // Cocos  (Keeling)  Islands
  cd: [-2.81, 23.59], // Democratic Republic of Congo
  cf: [6.65, 20.42], // Central African Republic
  cg: [-0.75, 15.17], // Republic of Congo
  ch: [46.83, 8.16], // Switzerland
  ci: [7.71, -5.61], // Côte d'Ivoire
  ck: [-21.1, -159.74], // Cook Islands
  cl: [-37.85, -71.5], // Chile
  cm: [5.78, 12.69], // Cameroon
  cn: [37.67, 104.04], // China
  co: [4.01, -73.08], // Colombia
  cr: [10.04, -84.19], // Costa Rica
  cu: [21.67, -78.96], // Cuba
  cv: [15.14, -23.67], // Cape Verde
  cw: [12.26, -68.98], // Curaçao
  cx: [-10.38, 105.56], // Christmas Island
  cy: [35.07, 33.16], // Cyprus
  cz: [49.77, 15.26], // Czech Republic
  de: [51.23, 10.34], // Germany
  dj: [11.81, 42.5], // Djibouti
  dk: [56.29, 9.31], // Denmark
  dm: [15.49, -61.37], // Dominica
  do: [18.94, -70.51], // Dominican Republic
  dz: [28.45, 2.57], // Algeria
  ec: [-1.35, -78.39], // Ecuador
  ee: [58.74, 25.77], // Estonia
  eg: [26.63, 29.8], // Egypt
  eh: [24.73, -13.16], // Western Sahara
  er: [15.42, 38.77], // Eritrea
  es: [40.51, -3.6], // Spain
  et: [8.72, 39.53], // Ethiopia
  fi: [64.97, 26.26], // Finland
  fj: [-17.7, 177.84], // Fiji
  fk: [-51.67, -58.77], // Falkland Islands
  fm: [6.96, 158.11], // Federated States of Micronesia
  fo: [62.22, -6.92], // Faroe Islands
  fr: [46.77, 2.41], // France
  ga: [-0.5, 11.74], // Gabon
  gb: [54.16, -2.6], // United Kingdom
  gd: [12.18, -61.69], // Grenada
  ge: [42.2, 43.44], // Georgia
  gf: [4.01, -53.26], // French Guiana
  gg: [49.5, -2.61], // Guernsey
  gh: [8.03, -1.26], // Ghana
  gi: [36.16, -5.38], // Gibraltar
  gl: [77.37, -41.13], // Greenland
  gm: [13.51, -15.43], // Gambia
  gn: [10.51, -10.98], // Guinea
  go: [-11.45, 47.22], // Glorioso Islands
  gp: [16.22, -61.68], // Guadeloupe
  gq: [1.65, 10.42], // Equatorial Guinea
  gr: [39.54, 22.54], // Greece
  gs: [-54.3, -36.71], // South Georgia and South Sandwich Islands
  gt: [15.75, -90.36], // Guatemala
  gu: [13.5, 144.65], // Guam
  gw: [12.13, -14.96], // Guinea-Bissau
  gy: [4.88, -58.99], // Guyana
  hk: [22.48, 114.04], // Hong Kong
  hm: [-53.01, 73.44], // Heard Island and McDonald Islands
  hn: [14.88, -86.61], // Honduras
  hr: [45.2, 16.38], // Croatia
  ht: [18.98, -72.68], // Haiti
  hu: [47.2, 19.35], // Hungary
  id: [-0.1, 113.91], // Indonesia
  ie: [53.23, -8.17], // Ireland
  il: [31.51, 34.95], // Israel
  im: [54.26, -4.58], // Isle of Man
  in: [23.28, 79.52], // India
  io: [-7.23, 72.37], // British Indian Ocean Territory
  iq: [33.14, 43.66], // Iraq
  ir: [32.8, 54.12], // Iran
  is: [65.07, -18.6], // Iceland
  it: [43.67, 12.03], // Italy
  je: [49.25, -2.17], // Jersey
  jm: [18.2, -77.31], // Jamaica
  jo: [31.29, 36.72], // Jordan
  jp: [36.75, 137.92], // Japan
  ju: [-16.94, 42.68], // Juan De Nova Island
  ke: [0.69, 37.73], // Kenya
  kg: [41.5, 74.47], // Kyrgyzstan
  kh: [12.79, 104.81], // Cambodia
  ki: [1.94, -157.33], // Kiribati
  km: [-11.54, 43.28], // Comoros
  kn: [17.38, -62.75], // Saint Kitts and Nevis
  kp: [40.21, 127.1], // North Korea
  kr: [36.51, 127.76], // South Korea
  kw: [29.35, 47.5], // Kuwait
  ky: [19.37, -81.28], // Cayman Islands
  kz: [48.47, 67.25], // Kazakhstan
  la: [18.59, 103.62], // Lao People's Democratic Republic
  lb: [33.95, 35.82], // Lebanon
  lc: [13.95, -60.98], // Saint Lucia
  li: [47.16, 9.49], // Liechtenstein
  lk: [7.68, 80.62], // Sri Lanka
  lr: [6.53, -9.36], // Liberia
  ls: [-29.46, 28.17], // Lesotho
  lt: [55.38, 23.83], // Lithuania
  lu: [49.8, 6.03], // Luxembourg
  lv: [56.9, 24.85], // Latvia
  ly: [27.19, 17.93], // Libya
  ma: [31.97, -6.33], // Morocco
  mc: [43.78, 7.36], // Monaco
  md: [47.24, 28.4], // Moldova
  me: [42.82, 19.19], // Montenegro
  mf: [18.14, -63.07], // Saint Martin
  mg: [-19.35, 46.62], // Madagascar
  mh: [7.18, 171.05], // Marshall Islands
  mk: [41.62, 21.63], // Macedonia
  ml: [17.49, -3.56], // Mali
  mm: [21.39, 96.39], // Myanmar
  mn: [46.99, 102.92], // Mongolia
  mo: [22.26, 113.41], // Macau
  mp: [15.23, 145.62], // Northern Mariana Islands
  mq: [14.71, -61.03], // Martinique
  mr: [20.39, -10.37], // Mauritania
  ms: [16.79, -62.19], // Montserrat
  mt: [35.92, 14.39], // Malta
  mu: [-20.15, 57.5], // Mauritius
  mv: [3.34, 73.33], // Maldives
  mw: [-13.13, 34.23], // Malawi
  mx: [24.22, -102.67], // Mexico
  my: [3.7, 114.62], // Malaysia
  mz: [-17.29, 35.44], // Mozambique
  na: [-22.12, 17.17], // Namibia
  nc: [-21.2, 165.36], // New Caledonia
  ne: [17.53, 9.37], // Niger
  nf: [-28.93, 167.82], // Norfolk Island
  ng: [9.68, 8.05], // Nigeria
  ni: [12.91, -85.02], // Nicaragua
  nl: [52.33, 5.6], // Netherlands
  no: [65.21, 14.87], // Norway
  np: [28.29, 83.81], // Nepal
  nr: [-0.43, 166.8], // Nauru
  nu: [-18.93, -170.01], // Niue
  nz: [-43.93, 170.36], // New Zealand
  om: [20.66, 56.03], // Oman
  pa: [8.59, -80.11], // Panama
  pe: [-9.13, -74.36], // Peru
  pf: [-17.54, -149.38], // French Polynesia
  pg: [-6.51, 144.13], // Papua New Guinea
  ph: [16.03, 121.31], // Philippines
  pk: [30.17, 69.37], // Pakistan
  pl: [52.22, 19.32], // Poland
  pm: [46.97, -56.34], // Saint Pierre and Miquelon
  pn: [-24.24, -128.29], // Pitcairn Islands
  pr: [18.28, -66.49], // Puerto Rico
  ps: [31.98, 35.19], // Palestinian Territories
  pt: [39.74, -8.01], // Portugal
  pw: [7.58, 134.47], // Palau
  py: [-23.15, -58.39], // Paraguay
  qa: [25.34, 51.12], // Qatar
  re: [-20.99, 55.47], // Reunion
  ro: [45.91, 24.91], // Romania
  rs: [44.27, 20.73], // Serbia
  ru: [64.13, 101.54], // Russia
  rw: [-1.9, 29.86], // Rwanda
  sa: [24.32, 44.41], // Saudi Arabia
  sb: [-9.51, 160.04], // Solomon Islands
  sc: [-4.56, 55.41], // Seychelles
  sd: [16.13, 29.9], // Sudan
  se: [63.5, 16.93], // Sweden
  sg: [1.44, 103.72], // Singapore
  sh: [-15.84, -5.75], // Saint Helena
  si: [46.15, 14.76], // Slovenia
  sj: [78.74, 15.81], // Svalbard and Jan Mayen
  sk: [48.74, 19.43], // Slovakia
  sl: [8.64, -11.82], // Sierra Leone
  sm: [43.97, 12.41], // San Marino
  sn: [14.43, -14.51], // Senegal
  so: [6.18, 45.8], // Somalia
  sr: [4.21, -55.92], // Suriname
  ss: [7.39, 30.19], // South Sudan
  st: [0.33, 6.56], // Sao Tome and Principe
  sv: [13.8, -88.86], // El Salvador
  sx: [18.1, -63.06], // Saint Martin
  sy: [35.08, 38.46], // Syria
  sz: [-26.43, 31.42], // Swaziland
  tc: [21.85, -71.74], // Turks and Caicos Islands
  td: [15.49, 18.6], // Chad
  tf: [-49.22, 69.42], // French Southern and Antarctic Lands
  tg: [8.6, 0.92], // Togo
  th: [15.26, 100.91], // Thailand
  tj: [38.57, 70.93], // Tajikistan
  tk: [-8.46, -172.63], // Tokelau
  tl: [-8.7, 125.81], // Timor-Leste
  tm: [39.19, 59.26], // Turkmenistan
  tn: [34.2, 9.5], // Tunisia
  to: [-21.04, -175.36], // Tonga
  tr: [39.05, 35.37], // Turkey
  tt: [10.49, -61.3], // Trinidad and Tobago
  tv: [-8.41, 179.08], // Tuvalu
  tw: [23.8, 120.86], // Taiwan
  tz: [-6.19, 34.75], // Tanzania
  ua: [49.11, 31.29], // Ukraine
  ug: [1.36, 32.31], // Uganda
  "um-dq": [-0.3, -159.98], // Jarvis Island
  "um-fq": [0.31, -176.6], // Baker Island
  "um-hq": [0.89, -176.78], // Howland Island
  "um-jq": [16.78, -169.68], // Johnston Atoll
  "um-mq": [28.24, -177.52], // Midway Islands
  "um-wq": [19.35, 166.51], // Wake Island
  us: [40.04, -99.63], // United States
  uy: [-32.7, -56.03], // Uruguay
  uz: [41.86, 62.98], // Uzbekistan
  va: [41.93, 12.39], // Vatican City
  vc: [13.31, -61.2], // Saint Vincent and the Grenadines
  ve: [7.21, -66.2], // Venezuela
  vg: [18.47, -64.63], // British Virgin Islands
  vi: [17.79, -64.78], // US Virgin Islands
  vn: [16.87, 106.18], // Vietnam
  vu: [-15.11, 166.72], // Vanuatu
  wf: [-14.17, -178.27], // Wallis and Futuna
  ws: [-13.52, -172.58], // Samoa
  xk: [42.6, 20.82], // Kosovo
  ye: [16, 47.49], // Yemen
  yt: [-12.71, 45.07], // Mayotte
  za: [-29.01, 25.05], // South Africa
  zm: [-13.38, 27.7], // Zambia
  zw: [-18.91, 29.79], // Zimbabwe
};

/** The centre of a country, or null when it isn't one this map knows. */
export function countryCentroid(code: string): [number, number] | null {
  return COUNTRY_CENTROIDS[code.toLowerCase()] ?? null;
}
