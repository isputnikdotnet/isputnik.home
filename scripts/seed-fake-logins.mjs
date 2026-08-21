// Fills the dev database with invented sign-ins, devices, blocks and attempt
// history from around the world, so the Dashboard's Locations, Logins and Devices
// views and the Security page's Blocked IPs have something to draw — and so the
// lockout and auto-block machinery has a realistic history to decide against.
//
// DEVELOPMENT ONLY. It writes rows describing things that never happened. Never
// point it at a database anyone relies on. Everything it writes is tagged so
// `--clear` can take it all back out and leave the real rows alone:
//
//   activity_logs   target_type = 'fake-seed'   (a column no page displays)
//   sessions        token_hash starts 'fakeseed' (a hash no token can produce,
//                                                 so a seeded session is dead on
//                                                 arrival as a credential)
//   blocked_ips     reason ends '[seeded]'      (visible, deliberately — a block
//                                                 that silently refuses someone
//                                                 should say where it came from)
//   login_attempts  id starts 'seed-'           (ids there are only counted and
//                                                 ordered, never shown)
//
//   node scripts/seed-fake-logins.mjs              # seed the default spread
//   node scripts/seed-fake-logins.mjs --dry-run    # show what it would seed
//   node scripts/seed-fake-logins.mjs --clear      # remove everything seeded
//   node scripts/seed-fake-logins.mjs --us-cities=10 --world=10 --days=60
//   node scripts/seed-fake-logins.mjs --lock=someone@example.com   # lock that account
//
// It also creates a handful of member accounts (…@seed.local) to spread the
// sign-ins across, each pinned to one of the sampled cities so a person's
// history reads like a person: mostly from home, occasionally from elsewhere.
// Their password hash is the literal text 'seeded:no-password', which the
// verifier rejects before hashing anything — the accounts exist to be rows in
// tables, and can never be signed in to. `--clear` removes them too.
//
// The addresses are not made up. Inventing an address and hoping it lands in
// Ohio does not work — so this samples real ones out of the address space and
// asks the same local database the server asks, keeping the ones that resolve
// until it has the spread it wants. What gets seeded is therefore whatever that
// database actually believes, which is the point: the map should be tested
// against the lookups it will really do.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Reader } from "maxmind";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DB_PATH = process.env.DB_PATH ?? path.join(ROOT, "data", "db", "isputnik.sqlite");
const GEOIP_DIR = process.env.GEOIP_PATH ?? path.join(ROOT, "data", "geoip");
const LOG_MARKER = "fake-seed";
const SESSION_MARKER = "fakeseed";
const BLOCK_MARKER = "[seeded]";
const ATTEMPT_MARKER = "seed-";

const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, "").split("=");
    return [key, value ?? "true"];
  })
);
const flag = (name) => args.get(name) === "true";
const number = (name, fallback) => {
  const raw = args.get(name);
  const value = raw === undefined ? fallback : Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
};

const WANT_US_CITIES = number("us-cities", 10);
const WANT_WORLD_CITIES = number("world", 10);
const DAYS = number("days", 30);

// ── the address space ──────────────────────────────────────────────────────────

// Everything that is not a routable public address. Sampling has to skip these
// or a good share of the draws are wasted on addresses no sign-in could carry —
// and isPublic() below is also the guard that keeps a private address, which
// could be someone's own machine, out of the blocked list entirely.
function isPublic(ip) {
  const [a, b] = ip.split(".").map(Number);
  if (!Number.isInteger(a) || !Number.isInteger(b)) return false;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  return true;
}

// Seeded, so two runs of this script pick the same addresses and a bug found
// against one seeding can be reproduced against the next.
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = mulberry32(20260821);
const pick = (list) => list[Math.floor(random() * list.length)];
const between = (low, high) => low + Math.floor(random() * (high - low + 1));

// ── the local database, opened the way the server opens it ─────────────────────

function openReader() {
  let names;
  try {
    names = fs.readdirSync(GEOIP_DIR).filter((name) => name.toLowerCase().endsWith(".mmdb"));
  } catch {
    return null;
  }
  const found = [];
  for (const name of names) {
    const file = path.join(GEOIP_DIR, name);
    try {
      const reader = new Reader(fs.readFileSync(file));
      const type = reader.metadata?.databaseType ?? "Unknown";
      found.push({ name, reader, tier: /city/i.test(type) ? "city" : "country" });
    } catch {
      // Not a database. Skipped, same as the server does.
    }
  }
  // The city tier wins when there is one — it is what puts towns on the map.
  found.sort((a, b) => (a.tier === b.tier ? 0 : a.tier === "city" ? -1 : 1));
  return found[0] ?? null;
}

function lookup(reader, tier, ip) {
  const found = reader.get(ip);
  const code = found?.country?.iso_code ?? found?.registered_country?.iso_code ?? null;
  if (!code) return null;
  return {
    code,
    name: found?.country?.names?.en ?? found?.registered_country?.names?.en ?? null,
    city: tier === "city" ? found?.city?.names?.en ?? null : null,
    region: tier === "city" ? found?.subdivisions?.[0]?.names?.en ?? null : null,
    latitude: tier === "city" ? found?.location?.latitude ?? null : null,
    longitude: tier === "city" ? found?.location?.longitude ?? null : null
  };
}

/**
 * Draws addresses at random and keeps the ones that widen the spread: a US city
 * not seen yet (each in its own state, so the ten don't pile into California),
 * or a city in a country not seen yet. Stops when both quotas are met, or when
 * the sample budget runs out — a database with thin coverage should return a
 * short list rather than spin. On a country-tier database there are no cities to
 * ask for, so the worldwide quota falls back to countries and the US appears
 * once, undivided.
 */
function sampleAddresses(reader, tier) {
  const us = new Map();
  const world = new Map();
  const budget = 500_000;

  for (let draw = 0; draw < budget; draw += 1) {
    if (us.size >= WANT_US_CITIES && world.size >= WANT_WORLD_CITIES) break;
    const ip = `${between(0, 255)}.${between(0, 255)}.${between(0, 255)}.${between(1, 254)}`;
    if (!isPublic(ip)) continue;
    const hit = lookup(reader, tier, ip);
    if (!hit) continue;
    if (tier === "city" && !hit.city) continue;

    if (hit.code === "US") {
      const key = hit.region ?? "US";
      if (!us.has(key) && us.size < WANT_US_CITIES) us.set(key, { ip, hit });
      continue;
    }
    if (!world.has(hit.code) && world.size < WANT_WORLD_CITIES) world.set(hit.code, { ip, hit });
  }

  return [...world.values(), ...us.values()];
}

function describe(hit) {
  return [hit.city, hit.region, hit.name ?? hit.code].filter(Boolean).join(", ");
}

// ── accounts ───────────────────────────────────────────────────────────────────

// Extra members to spread the sign-ins across — a table where every row says the
// same two names doesn't look like data. The @seed.local domain is the marker
// --clear finds them by, and the password hash is unusable by construction: the
// verifier requires the 'scrypt:' scheme and refuses anything else outright.
const FAKE_ACCOUNTS = [
  ["Alex Morgan", "alex"],
  ["Nina Petrova", "nina"],
  ["Tom Becker", "tom"],
  ["Maria Silva", "maria"],
  ["Ken Tanaka", "ken"],
  ["Olivia Reed", "olivia"]
];

function createAccounts(db) {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO users (id, email, password_hash, display_name, role)
    VALUES (?, ?, 'seeded:no-password', ?, 'member')
  `);
  for (const [name, handle] of FAKE_ACCOUNTS) insert.run(newId(), `${handle}@seed.local`, name);
  return db.prepare("SELECT id, email, display_name, role FROM users WHERE email LIKE '%@seed.local'").all();
}

/**
 * Pins each account to one of the sampled cities. Sign-ins from an address are
 * then mostly its residents' — a person's history reads "home, home, home,
 * trip" instead of a different city every row, which is the shape the Logins
 * table and the new-network alert were designed around.
 */
function assignResidents(plans, users) {
  const friendly = plans.filter((plan) => !plan.hostile);
  const homes = friendly.length > 0 ? friendly : plans;
  users.forEach((user, index) => {
    const plan = homes[index % homes.length];
    (plan.residents ??= []).push(user);
  });
}

// ── sign-ins ───────────────────────────────────────────────────────────────────

// A believable shape for a family server: most sign-ins are the password form,
// a few are passkeys or a second factor, and a minority of addresses are the
// ones failing repeatedly — which is what the Failed column is there to show.
const SUCCESS_EVENTS = [
  ["auth.login", "Signed in.", 70],
  ["auth.passkey_login", "Signed in with a passkey.", 14],
  ["auth.mfa_verified", "Passed two-factor.", 12],
  ["auth.device_link_approved", "Approved a linked display.", 4]
];

function weighted(options) {
  const total = options.reduce((sum, option) => sum + option[2], 0);
  let cursor = random() * total;
  for (const option of options) {
    cursor -= option[2];
    if (cursor <= 0) return option;
  }
  return options[options.length - 1];
}

/**
 * Gives every sampled address a character before any row is written, so the rest
 * of the seeding can agree with itself: the addresses that hammer the sign-in
 * screen here are the same ones that end up in the blocked list.
 */
function planAddresses(addresses) {
  return addresses.map(({ ip, hit }) => ({
    ip,
    hit,
    // A handful of addresses carry most of the traffic and the rest carry a
    // little, the way a real household's log looks — one home ISP, a phone on
    // the move, and a scattering of strangers knocking. Twenty cities rather
    // than the old fifty-odd, so each carries more weight.
    connections: random() < 0.35 ? between(12, 60) : between(2, 9),
    // One address in six is having a bad time: mostly failures, which is what
    // makes it stand out in the table and what gets it blocked below.
    hostile: random() < 0.16
  }));
}

function buildLogins(plans, users, now) {
  const window = DAYS * 24 * 60 * 60 * 1000;
  const rows = [];
  for (const plan of plans) {
    for (let i = 0; i < plan.connections; i += 1) {
      const failed = plan.hostile ? random() < 0.8 : random() < 0.06;
      const [event, detail] = failed
        ? random() < 0.7
          ? ["auth.login_failed", "Sign-in failed: wrong password."]
          : ["auth.mfa_failed", "Two-factor code rejected."]
        : weighted(SUCCESS_EVENTS);
      // Failures are not attributed to a person: a wrong password does not prove
      // who was typing it. The user is carried on the row anyway so the matching
      // login_attempts row below can agree with this one about who signed in.
      // Mostly a resident of this address; now and then someone passing through.
      const who = plan.residents?.length && random() < 0.85 ? pick(plan.residents) : pick(users);
      rows.push({
        event,
        failed,
        user: failed ? null : who,
        detail: `${detail} (seeded — ${describe(plan.hit)})`,
        ip: plan.ip,
        at: new Date(now - Math.floor(random() * window)).toISOString()
      });
    }
  }
  return rows.sort((a, b) => a.at.localeCompare(b.at));
}

// ── devices ────────────────────────────────────────────────────────────────────

// Real user agents, because the Devices table reads them: describeUserAgent()
// turns them into "Chrome on Android" and deviceType() sorts them into the four
// counters at the top. A linked display gets kind='device' instead, which is how
// the server knows it is a screen in a room rather than a person at a keyboard.
const AGENTS = {
  phone: [
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
    "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
    "Mozilla/5.0 (Linux; Android 14; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/138.0.0.0 Mobile Safari/537.36"
  ],
  tablet: [
    "Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/604.1",
    "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"
  ],
  computer: [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.4 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36"
  ],
  display: [
    "Mozilla/5.0 (SMART-TV; Linux; Tizen 7.0) AppleWebKit/537.36 (KHTML, like Gecko) Version/7.0 TV Safari/537.36",
    "Mozilla/5.0 (Web0S; Linux/SmartTV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36"
  ]
};

const DISPLAY_LABELS = ["Living Room TV", "Kitchen display", "Bedroom TV", "Study monitor"];
const DEVICE_LABELS = [null, null, null, "Work laptop", "The old iPad", "Sasha's phone"];

const DAY = 24 * 60 * 60 * 1000;

/**
 * A household's devices. Most sit on the LAN, which is where a family's screens
 * actually are — those show as "Your home network" and count toward the home
 * total on Locations. A couple are signed in from outside, which is the row an
 * admin is really scanning this table for.
 */
function buildDevices(plans, users, now) {
  const lan = () => `192.168.1.${between(20, 199)}`;
  const away = plans.filter((plan) => !plan.hostile);
  const rows = [];

  const add = (kind, type, ip, label) => {
    const agent = pick(AGENTS[type]);
    const lastSeen = now - Math.floor(random() * (kind === "device" ? 3 : 9)) * DAY - between(0, 20) * 3_600_000;
    rows.push({
      user: pick(users).id,
      // A linked display outlives every browser session — a year against a month.
      created: new Date(lastSeen - between(kind === "device" ? 40 : 2, kind === "device" ? 300 : 25) * DAY).toISOString(),
      expires: new Date(now + (kind === "device" ? 330 : between(4, 29)) * DAY).toISOString(),
      lastSeen: new Date(lastSeen).toISOString(),
      agent,
      ip,
      kind,
      label
    });
  };

  for (const label of DISPLAY_LABELS.slice(0, 3)) add("device", "display", lan(), label);
  for (let i = 0; i < 4; i += 1) add("browser", "phone", lan(), pick(DEVICE_LABELS));
  for (let i = 0; i < 2; i += 1) add("browser", "tablet", lan(), pick(DEVICE_LABELS));
  for (let i = 0; i < 4; i += 1) add("browser", "computer", lan(), pick(DEVICE_LABELS));
  // Signed in from somewhere else in the world — the interesting row.
  for (let i = 0; i < 2 && i < away.length; i += 1) add("browser", "phone", away[i].ip, null);
  if (away.length > 2) add("browser", "computer", away[2].ip, "Work laptop");

  return rows.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

// ── blocks ─────────────────────────────────────────────────────────────────────

/**
 * The addresses that spent the window failing, now blocked for it. Most are the
 * automatic kind with a cooldown — some still running, some already lapsed, which
 * is the pair of states the Blocked IPs table renders differently — and a couple
 * are the permanent kind an admin placed by hand.
 */
function buildBlocks(plans, admin, now) {
  const hostile = plans.filter((plan) => plan.hostile && isPublic(plan.ip));
  return hostile.map((plan, index) => {
    const placed = now - Math.floor(random() * DAYS * DAY);
    const manual = index % 5 === 2;
    // A lapsed cooldown is worth seeding: the table marks it expired rather than
    // hiding it, and that state is easy to get wrong. Chosen by position rather
    // than by a coin flip, so a short blocked list still shows every state.
    const lapsed = !manual && index % 3 === 1;
    return {
      ip: plan.ip,
      reason: manual
        ? `Blocked by hand after repeated attempts from ${describe(plan.hit)}. ${BLOCK_MARKER}`
        : `${plan.connections} failed sign-ins from ${describe(plan.hit)}. ${BLOCK_MARKER}`,
      auto: manual ? 0 : 1,
      created: new Date(placed).toISOString(),
      expires: manual ? null : new Date(placed + (lapsed ? between(1, 6) : between(30, 400)) * 3_600_000).toISOString(),
      by: manual ? admin : null
    };
  });
}

// ── login attempts ─────────────────────────────────────────────────────────────

// login_attempts is not a table any page renders — it is what the lockout and the
// per-IP auto-block are computed from, plus what "backfill known networks" reads.
// Seeding it is therefore about behaviour, not about filling a screen: it gives
// those mechanisms a realistic history to decide against.

// Addresses that fail against a name rather than an account: the addresses this
// script marks hostile are knocking, not mistyping, and a scanner guesses these.
const GUESSED_EMAILS = [
  "admin@localhost", "admin@isputnik.home", "root@localhost", "info@isputnik.home",
  "test@isputnik.home", "administrator@isputnik.home", "guest@isputnik.home", "backup@isputnik.home"
];

// What a scanner does besides guess passwords. These count only toward the per-IP
// block — never a lockout, because a row with no email can't name an account.
const ABUSE_KINDS = ["probe", "probe", "probe", "token"];

/**
 * Mirrors the seeded sign-ins into login_attempts, and adds the scanner traffic
 * that a hostile address brings with it.
 *
 * The one rule that matters: this must never lock the household out of its own
 * server. A real account's failures are only ever seeded OLDER than the lockout
 * window, and `settle` below then drops any that would still count. Everything a
 * hostile address does is aimed at a guessed name instead, which is both safer
 * and what actually happens.
 */
function buildAttempts(plans, logins, users, now, policy) {
  const rows = [];

  for (const login of logins) {
    if (!login.failed) {
      rows.push({ email: login.user.email.toLowerCase(), ip: login.ip, successful: 1, kind: "signin", at: login.at });
      continue;
    }
    // Most failures are a stranger guessing a name. About one in six is a member
    // of the household fumbling their own password, which is the case worth having
    // in the table — and the case settle() below exists to keep harmless.
    const fumble = random() < 0.16;
    rows.push({
      email: (fumble ? pick(users).email : pick(GUESSED_EMAILS)).toLowerCase(),
      ip: login.ip,
      successful: 0,
      kind: "signin",
      at: login.at
    });
  }

  // A knocking address sweeps paths and tries tokens as well as passwords; the
  // block reason the server writes ("15 scanner probes and 6 failed sign-ins")
  // only reads right when both kinds are there.
  for (const plan of plans.filter((entry) => entry.hostile)) {
    for (let i = 0; i < between(4, 22); i += 1) {
      rows.push({
        email: null,
        ip: plan.ip,
        successful: 0,
        kind: pick(ABUSE_KINDS),
        at: new Date(now - Math.floor(random() * DAYS * DAY)).toISOString()
      });
    }
  }

  return settle(rows.sort((a, b) => a.at.localeCompare(b.at)), now, policy);
}

/**
 * The safety pass. accountFailureCount() counts an account's failures inside the
 * lockout window that come after its last success, so a seeded account is safe
 * exactly when neither of those holds. This drops the rows that would break it —
 * dropping rather than reshuffling, because a row that could lock someone out is
 * not worth keeping at all.
 */
function settle(rows, now, policy) {
  const cutoff = now - policy.lockoutMinutes * 60_000;
  const accounts = new Set(rows.filter((row) => row.successful === 1).map((row) => row.email));
  const lastSuccess = new Map();
  rows.forEach((row, index) => {
    if (row.successful === 1) lastSuccess.set(row.email, index);
  });

  return rows.filter((row, index) => {
    if (row.successful === 1 || row.email === null || !accounts.has(row.email)) return true;
    if (Date.parse(row.at) > cutoff) return false; // inside the lockout window
    return index < (lastSuccess.get(row.email) ?? -1); // after the last success
  });
}

/**
 * Runs the server's own lockout sum over the rows about to be written, and names
 * any account they would lock. settle() is meant to make this impossible, so this
 * is the proof rather than the mechanism — the rows go in in array order, so an
 * index here is the rowid the server will compare.
 */
function wouldLock(attempts, users, now, policy) {
  const cutoff = now - policy.lockoutMinutes * 60_000;
  const locked = [];
  for (const user of users) {
    const email = user.email.toLowerCase();
    let lastSuccess = -1;
    attempts.forEach((row, index) => {
      if (row.email === email && row.successful === 1) lastSuccess = index;
    });
    const failures = attempts.filter(
      (row, index) =>
        row.email === email && row.successful === 0 && index > lastSuccess && Date.parse(row.at) > cutoff
    ).length;
    if (failures >= policy.lockoutThreshold) locked.push(`${user.email} (${failures} failures)`);
  }
  return locked;
}

/** The live lockout thresholds, merged over the server's own defaults. */
function readPolicy(db) {
  const fallback = { lockoutThreshold: 5, lockoutMinutes: 30 };
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'security_policy'").get();
  if (!row) return fallback;
  try {
    const stored = JSON.parse(row.value);
    return {
      lockoutThreshold: stored.lockoutThreshold ?? fallback.lockoutThreshold,
      lockoutMinutes: stored.lockoutMinutes ?? fallback.lockoutMinutes
    };
  } catch {
    return fallback;
  }
}

/** `--lock=someone@example.com`: enough failures, right now, to lock that account. */
function buildLockout(email, ip, now, policy) {
  return Array.from({ length: policy.lockoutThreshold }, (_, i) => ({
    email: email.toLowerCase(),
    ip,
    successful: 0,
    kind: "signin",
    at: new Date(now - (policy.lockoutThreshold - i) * 20_000).toISOString()
  }));
}

// ── writing it down ────────────────────────────────────────────────────────────

// nanoid is the server's id shape; a hand-rolled one of the same alphabet and
// length keeps this script free of the app's imports.
const ALPHABET = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";
const newId = () => Array.from({ length: 16 }, () => ALPHABET[Math.floor(random() * ALPHABET.length)]).join("");
// login_attempts has no column to spare for a marker, so the id carries it. Ids
// there are never shown or matched on — only counted and compared by rowid.
const attemptId = () => `${ATTEMPT_MARKER}${newId().slice(0, 11)}`;
const HEX = "0123456789abcdef";
// 64 characters like a real sha256, but the first eight spell the marker — no
// token hashes to this, so a seeded session can never authenticate anything.
const fakeHash = () =>
  SESSION_MARKER + Array.from({ length: 56 }, () => HEX[Math.floor(random() * 16)]).join("");

function clear(db) {
  const logs = db.prepare("DELETE FROM activity_logs WHERE target_type = ?").run(LOG_MARKER).changes;
  const sessions = db.prepare("DELETE FROM sessions WHERE token_hash LIKE ?").run(`${SESSION_MARKER}%`).changes;
  const blocks = db.prepare("DELETE FROM blocked_ips WHERE reason LIKE ?").run(`%${BLOCK_MARKER}`).changes;
  // An account this script had locked is unlocked again by this delete: the lock
  // is derived purely from these rows, so removing them removes the lock.
  const attempts = db.prepare("DELETE FROM login_attempts WHERE id LIKE ?").run(`${ATTEMPT_MARKER}%`).changes;
  // The invented accounts go last, once nothing seeded points at them any more.
  // Their sessions cascade; known_login_networks (written at runtime if the
  // new-network alert ran against them) does not, so it is swept first.
  db.prepare(
    "DELETE FROM known_login_networks WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@seed.local')"
  ).run();
  const accounts = db.prepare("DELETE FROM users WHERE email LIKE '%@seed.local'").run().changes;
  console.log(
    `Removed ${logs.toLocaleString()} sign-in${logs === 1 ? "" : "s"}, ` +
      `${sessions} device${sessions === 1 ? "" : "s"}, ${blocks} block${blocks === 1 ? "" : "s"}, ` +
      `${attempts.toLocaleString()} login attempt${attempts === 1 ? "" : "s"} and ` +
      `${accounts} account${accounts === 1 ? "" : "s"}.`
  );
}

function seeded(db) {
  return (
    db.prepare("SELECT COUNT(*) AS n FROM activity_logs WHERE target_type = ?").get(LOG_MARKER).n +
    db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE token_hash LIKE ?").get(`${SESSION_MARKER}%`).n +
    db.prepare("SELECT COUNT(*) AS n FROM blocked_ips WHERE reason LIKE ?").get(`%${BLOCK_MARKER}`).n +
    db.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE id LIKE ?").get(`${ATTEMPT_MARKER}%`).n +
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE email LIKE '%@seed.local'").get().n
  );
}

function main() {
  const db = new Database(DB_PATH);

  if (flag("clear")) {
    clear(db);
    db.close();
    return;
  }

  const already = seeded(db);
  if (already > 0 && !flag("dry-run")) {
    console.log(`${already.toLocaleString()} seeded rows are already here — run with --clear first to replace them.`);
    db.close();
    return;
  }

  const active = openReader();
  if (!active) {
    console.error(`No location database in ${GEOIP_DIR}. Fetch one from the Locations page first.`);
    process.exitCode = 1;
    db.close();
    return;
  }
  console.log(`Reading ${active.name} (${active.tier} tier).`);

  // A dry run must not write, so it fakes the accounts in memory instead; a real
  // run creates them first so the SELECT below picks them up with everyone else.
  const seededAccounts = flag("dry-run")
    ? FAKE_ACCOUNTS.map(([name, handle]) => ({
        id: `dry-${handle}`,
        email: `${handle}@seed.local`,
        display_name: name,
        role: "member"
      }))
    : createAccounts(db);

  const users = db
    .prepare("SELECT id, email, display_name, role FROM users WHERE deleted_at IS NULL")
    .all()
    .concat(flag("dry-run") ? seededAccounts : []);
  if (users.length === 0) {
    console.error("No users to attribute sign-ins to.");
    process.exitCode = 1;
    db.close();
    return;
  }
  const admin = (users.find((user) => user.role === "admin") ?? users[0]).id;

  // The lockout thresholds are admin-tunable, so read the live ones rather than
  // assuming the defaults — the safety pass in settle() is only safe if it uses
  // the same window the server will.
  const policy = readPolicy(db);

  const now = Date.now();
  const plans = planAddresses(sampleAddresses(active.reader, active.tier));
  assignResidents(plans, users);
  const logins = buildLogins(plans, users, now);
  const devices = buildDevices(plans, users, now);
  const blocks = buildBlocks(plans, admin, now);
  const attempts = buildAttempts(plans, logins, users, now, policy);

  // --lock=<email> is the one way this script will deliberately lock someone out,
  // and only an account that exists. Undone by --clear, or by the admin's own
  // "clear lockout" action.
  const lockEmail = args.get("lock");
  if (lockEmail && lockEmail !== "true") {
    const target = users.find((user) => user.email.toLowerCase() === lockEmail.toLowerCase());
    if (!target) {
      console.error(`No account here with the email ${lockEmail}.`);
      process.exitCode = 1;
      db.close();
      return;
    }
    attempts.push(...buildLockout(target.email, plans[0].ip, now, policy));
    console.log(`Will LOCK ${target.email} with ${policy.lockoutThreshold} failures — undo with --clear.`);
  }

  // Locking someone out of their own dev server is the one way this script could
  // really hurt, so it does not merely intend to avoid it — it checks, using the
  // server's own sum, and refuses to write if it got it wrong.
  const wouldBeLocked = wouldLock(attempts, users, now, policy).filter(
    (entry) => !lockEmail || !entry.toLowerCase().startsWith(lockEmail.toLowerCase())
  );
  if (wouldBeLocked.length > 0) {
    console.error(`Refusing to write — these accounts would be locked out: ${wouldBeLocked.join(", ")}`);
    process.exitCode = 1;
    db.close();
    return;
  }

  // A private address in the blocked list could lock the household out of its own
  // server. isPublic() already filters both the sample and buildBlocks, so this is
  // a backstop that refuses to write rather than a filter that quietly drops one.
  const unsafe = blocks.filter((block) => !isPublic(block.ip));
  if (unsafe.length > 0) {
    console.error(`Refusing to block a non-public address: ${unsafe.map((b) => b.ip).join(", ")}`);
    process.exitCode = 1;
    db.close();
    return;
  }

  console.log("");
  for (const plan of plans) {
    const at = plan.hit.latitude === null ? "" : ` (${plan.hit.latitude.toFixed(2)}, ${plan.hit.longitude.toFixed(2)})`;
    const who = plan.residents?.length ? `  — ${plan.residents.map((r) => r.display_name).join(", ")}` : "";
    console.log(
      `  ${plan.ip.padEnd(16)} ${plan.hit.code}  ${describe(plan.hit)}${at}${plan.hostile ? "  ← blocked" : who}`
    );
  }

  const countries = new Set(plans.map((plan) => plan.hit.code));
  const usCities = new Set(plans.filter((p) => p.hit.code === "US" && p.hit.city).map((p) => p.hit.city));
  const towns = new Set(plans.filter((p) => p.hit.city).map((p) => `${p.hit.code}/${p.hit.city}`));

  console.log("");
  console.log(
    `${logins.length.toLocaleString()} sign-ins from ${plans.length} addresses · ` +
      `${usCities.size} US cities · ${towns.size - usCities.size} worldwide · ` +
      `${countries.size} countries · last ${DAYS} days`
  );
  console.log(`${seededAccounts.length} member accounts (…@seed.local, no usable password)`);
  console.log(
    `${devices.length} devices (${devices.filter((d) => d.kind === "device").length} linked displays, ` +
      `${devices.filter((d) => isPublic(d.ip)).length} signed in from outside)`
  );
  console.log(
    `${blocks.length} blocked addresses (${blocks.filter((b) => b.auto === 0).length} placed by hand, ` +
      `${blocks.filter((b) => b.expires && Date.parse(b.expires) <= now).length} already lapsed)`
  );
  console.log(
    `${attempts.length.toLocaleString()} login attempts (` +
      `${attempts.filter((a) => a.successful === 1).length} successful, ` +
      `${attempts.filter((a) => a.kind !== "signin").length} scanner probes and token guesses)`
  );

  if (flag("dry-run")) {
    console.log("Dry run — nothing written.");
    db.close();
    return;
  }

  const insertLog = db.prepare(`
    INSERT INTO activity_logs (id, event, actor_user_id, target_type, target_id, detail, ip_address, created_at)
    VALUES (@id, @event, @actor, '${LOG_MARKER}', NULL, @detail, @ip, @at)
  `);
  const insertSession = db.prepare(`
    INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, last_seen_at, device_name, ip_address, kind, label)
    VALUES (@id, @hash, @user, @created, @expires, @lastSeen, @agent, @ip, @kind, @label)
  `);
  const insertBlock = db.prepare(`
    INSERT OR REPLACE INTO blocked_ips (ip_address, reason, auto, created_at, expires_at, created_by)
    VALUES (@ip, @reason, @auto, @created, @expires, @by)
  `);
  const insertAttempt = db.prepare(`
    INSERT INTO login_attempts (id, email, ip_address, successful, kind, created_at)
    VALUES (@id, @email, @ip, @successful, @kind, @at)
  `);

  db.transaction(() => {
    for (const row of logins) {
      insertLog.run({
        id: newId(),
        event: row.event,
        actor: row.user?.id ?? null,
        detail: row.detail,
        ip: row.ip,
        at: row.at
      });
    }
    for (const row of devices) insertSession.run({ ...row, id: newId(), hash: fakeHash() });
    for (const row of blocks) insertBlock.run(row);
    // Written last and in time order, so rowid rises with created_at — which is
    // what accountFailureCount() compares against to find "since the last success".
    for (const row of attempts) insertAttempt.run({ ...row, id: attemptId() });
  })();

  console.log("");
  console.log("Written. Remove it all again with: node scripts/seed-fake-logins.mjs --clear");
  db.close();
}

main();
