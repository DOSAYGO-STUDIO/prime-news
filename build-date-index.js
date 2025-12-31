#!/usr/bin/env node
/**
 * Build date -> shard(s) reverse index from manifest.json
 *
 * Output:
 *  - ./docs/date-index.json  (YYYY-MM-DD -> [sid, sid, ...])
 *
 * Notes:
 *  - Uses shard tmin/tmax unix seconds to mark which shards overlap each UTC day.
 *  - If you want a specific TZ horizon, supply --tz-offset-minutes (e.g. -480 for America/Los_Angeles),
 *    which shifts the day boundary used for bucketing.
 *
 * Usage:
 *  node build-date-index.js --manifest ./docs/manifest.json --out ./docs/date-index.json
 *  node build-date-index.js --tz-offset-minutes -480
 */

const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv);

const MANIFEST = args.manifest || "./docs/manifest.json";
const OUT = args.out || "./docs/date-index.json";
const TZ_OFFSET_MIN = Number(args["tz-offset-minutes"] ?? 0); // shift day boundary

if (!fs.existsSync(MANIFEST)) {
  console.error(`manifest not found: ${MANIFEST}`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
if (!manifest.shards || !Array.isArray(manifest.shards)) {
  console.error("manifest.shards missing/invalid");
  process.exit(1);
}

function pad2(n) { return String(n).padStart(2, "0"); }

function dayKeyFromUnixSec(tSec) {
  // apply tz shift by moving time
  const shifted = (tSec + TZ_OFFSET_MIN * 60) * 1000;
  const d = new Date(shifted);
  const y = d.getUTCFullYear();
  const m = pad2(d.getUTCMonth() + 1);
  const day = pad2(d.getUTCDate());
  return `${y}-${m}-${day}`;
}

function unixDayStartShifted(tSec) {
  // returns unix seconds at start of shifted day boundary (UTC)
  const shifted = tSec + TZ_OFFSET_MIN * 60;
  return Math.floor(shifted / 86400) * 86400 - TZ_OFFSET_MIN * 60;
}

const dateIndex = {}; // day -> [sid...]

for (const s of manifest.shards) {
  const tmin = s.tmin;
  const tmax = s.tmax;
  if (tmin == null || tmax == null) continue;

  let cur = unixDayStartShifted(tmin);
  const end = unixDayStartShifted(tmax);

  while (cur <= end) {
    const day = dayKeyFromUnixSec(cur);
    if (!dateIndex[day]) dateIndex[day] = [];
    dateIndex[day].push(s.sid);
    cur += 86400;
  }
}

// sort shard lists and ensure uniqueness
for (const day of Object.keys(dateIndex)) {
  const arr = Array.from(new Set(dateIndex[day]));
  arr.sort((a, b) => a - b);
  dateIndex[day] = arr;
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  version: 1,
  tz_offset_minutes: TZ_OFFSET_MIN,
  created_at: new Date().toISOString(),
  days: dateIndex
}, null, 2));

console.log(`Wrote ${OUT} (${Object.keys(dateIndex).length} days indexed)`);

