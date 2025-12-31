#!/usr/bin/env node
const fs = require('fs');
const zlib = require('zlib');
const readline = require('readline');
const Database = require('better-sqlite3');
const path = require('path');

// CONFIG
function parseArgs(argv) {
    const out = {};
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
            out[key] = next;
            i++;
        } else {
            out[key] = true;
        }
    }
    return out;
}

const args = parseArgs(process.argv);
const SHARD_SIZE = 50_000;
const DATA_DIR = args.data || './data/raw';
const OUTPUT_DIR = args.out || './docs/shards';
const MAX_ID_ESTIMATE = 45_000_000;
const GZIP_SHARDS = !!args.gzip;

// SETUP
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function gzipFileSync(srcPath, dstPath) {
    const data = fs.readFileSync(srcPath);
    const gz = zlib.gzipSync(data, { level: 9 });
    fs.writeFileSync(dstPath, gz);
    return gz.length;
}

// --- HELPER: Turn HTML comment into readable snippet ---
function getSnippet(html) {
    if (!html) return '[Untitled]';
    // 1. Simple regex to strip HTML tags
    let text = html.replace(/<[^>]+>/g, ' ');
    // 2. Decode common entities (HN uses these a lot)
    text = text.replace(/&quot;/g, '"')
               .replace(/&#x27;/g, "'")
               .replace(/&lt;/g, '<')
               .replace(/&gt;/g, '>')
               .replace(/&amp;/g, '&');
    // 3. Collapse multiple spaces
    text = text.replace(/\s+/g, ' ').trim();
    // 4. Truncate
    if (text.length > 85) {
        return text.substring(0, 85) + '...';
    }
    return text || '[Untitled]';
}

// 1. GENERATE PRIME SIEVE
console.log(`[1/6] Generating Sieve up to ${MAX_ID_ESTIMATE}...`);
const isPrime = new Uint8Array(MAX_ID_ESTIMATE + 1).fill(1);
isPrime[0] = 0; isPrime[1] = 0;
for (let i = 2; i * i <= MAX_ID_ESTIMATE; i++) {
    if (isPrime[i]) {
        for (let j = i * i; j <= MAX_ID_ESTIMATE; j += i) isPrime[j] = 0;
    }
}

// --- SPECIAL PRIME CLASSIFIERS ---

// Mersenne: 2^p - 1 where result is prime
// Known Mersenne exponents that produce primes up to reasonable range
const MERSENNE_EXPONENTS = [2, 3, 5, 7, 13, 17, 19, 31];
const MERSENNE_PRIMES = new Set(MERSENNE_EXPONENTS.map(p => Math.pow(2, p) - 1).filter(n => n <= MAX_ID_ESTIMATE));

// Fermat: 2^(2^n) + 1 where result is prime
// Only F0-F4 are known Fermat primes: 3, 5, 17, 257, 65537
const FERMAT_PRIMES = new Set([3, 5, 17, 257, 65537]);

// Sophie Germain: p where both p and 2p+1 are prime
// We'll check this during processing
function isSophieGermain(p) {
    if (!isPrime[p]) return false;
    const q = 2 * p + 1;
    return q <= MAX_ID_ESTIMATE && isPrime[q];
}

// Palindrome primes: primes that read the same forwards and backwards
function isPalindrome(n) {
    const s = String(n);
    return s === s.split('').reverse().join('');
}

// p^k + k primes: n = p^k + k where p is prime and k is even
// Returns array of [p, k] pairs, e.g. [[3, 2]] for n=11 (3^2 + 2 = 11)
function getPkkRepresentations(n) {
    const results = [];
    for (let k = 2; k <= 40; k += 2) {
        if (k >= n) break;
        const base = n - k;
        if (base < 2) continue;
        const p = Math.round(Math.pow(base, 1 / k));
        if (p >= 2 && Math.pow(p, k) + k === n && isPrime[p]) {
            results.push([p, k]);
        }
    }
    return results;
}

// p^k + e primes: check if n = p^k + e for fixed e values (2,4,6,8,10,12)
// Returns object with matching e values, e.g. {2: [3,2], 4: [5,2]} meaning n=3^2+2 or n=5^2+4
function getPkPlusEFixed(n) {
    const matches = {};
    const fixedE = [2, 4, 6, 8, 10, 12];

    for (const e of fixedE) {
        const base = n - e;
        if (base < 2) continue;

        for (let k = 2; k <= 30; k++) {
            const p = Math.round(Math.pow(base, 1 / k));
            if (p < 2) break;
            if (Math.pow(p, k) === base && isPrime[p]) {
                matches[e] = [p, k];
                break;
            }
        }
    }
    return matches;
}

// p^k + e where e ≤ k² (returns first match)
function getPkEk2(n) {
    for (let k = 2; k <= 20; k++) {
        const maxE = k * k;
        for (let e = 2; e <= maxE; e += 2) {
            const base = n - e;
            if (base < 2) continue;
            const p = Math.round(Math.pow(base, 1 / k));
            if (p < 2) break;
            if (Math.pow(p, k) === base && isPrime[p]) {
                return { p, k, e };
            }
        }
    }
    return null;
}

// p^k + e where e < √p (returns first match)
function getPkEsqrt(n) {
    for (let k = 2; k <= 20; k++) {
        for (let p = 2; p < 100000; p++) {
            if (!isPrime[p]) continue;
            const pk = Math.pow(p, k);
            if (pk >= n) break;

            const e = n - pk;
            if (e > 0 && e % 2 === 0 && e < Math.sqrt(p)) {
                return { p, k, e };
            }
        }
    }
    return null;
}

// Get prime type(s) for an ID
function getPrimeType(id) {
    const n = Number(id);  // Ensure numeric comparison for Set.has()
    const types = [];

    // Classic special primes
    if (MERSENNE_PRIMES.has(n)) types.push('mersenne');
    if (FERMAT_PRIMES.has(n)) types.push('fermat');
    if (isSophieGermain(n)) types.push('germain');
    if (isPalindrome(n)) types.push('palindrome');

    // p^k + k representations (k even)
    const pkk = getPkkRepresentations(n);
    if (pkk.length > 0) {
        pkk.forEach(([p, k]) => types.push(`pkk:${p}-${k}`));
    }

    // p^k + e for fixed e values (2,4,6,8,10,12)
    const pkeFixed = getPkPlusEFixed(n);
    for (const [e, [p, k]] of Object.entries(pkeFixed)) {
        types.push(`pk${e}:${p}-${k}`);  // e.g., pk4:5-2 means 5^2+4
    }

    // p^k + e where e ≤ k²
    const pkeK2 = getPkEk2(n);
    if (pkeK2) {
        types.push(`pkek2:${pkeK2.p}-${pkeK2.k}-${pkeK2.e}`);
    }

    // p^k + e where e < √p
    const pkeSqrt = getPkEsqrt(n);
    if (pkeSqrt) {
        types.push(`pkesqrt:${pkeSqrt.p}-${pkeSqrt.k}-${pkeSqrt.e}`);
    }

    return types.length > 0 ? types.join(',') : null;
}

console.log(`[2/6] Pre-computed special primes: ${MERSENNE_PRIMES.size} Mersenne, ${FERMAT_PRIMES.size} Fermat`);

// 3. READ & FILTER (Streaming)
console.log(`[3/6] Processing JSON.gz files from ${DATA_DIR}...`);
const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json.gz'));
const primeScoreEarliest = new Map();
let collectedPrimes = [];

const processFile = (filename) => {
    return new Promise((resolve) => {
        const fileStream = fs.createReadStream(path.join(DATA_DIR, filename));
        const unzip = zlib.createGunzip();
        const rl = readline.createInterface({ input: fileStream.pipe(unzip), crlfDelay: Infinity });

        rl.on('line', (line) => {
            try {
                const item = JSON.parse(line);
                if (item.id < MAX_ID_ESTIMATE && isPrime[item.id]) {
                    
                    // --- LOGIC CHANGE HERE ---
                    let displayTitle = item.title;
                    if (!displayTitle && item.text) {
                        displayTitle = getSnippet(item.text);
                    }
                    if (!displayTitle) displayTitle = '[Untitled]';
                    // -------------------------

                    collectedPrimes.push({
                        id: item.id,
                        t: displayTitle,
                        u: item.by || 'anon',
                        s: item.score || 0,
                        d: item.time,
                        ty: item.type,
                        pt: getPrimeType(item.id)  // prime_type: mersenne, fermat, germain, or null
                    });
                    const score = Number(item.score) || 0;
                    if (item.type === 'story' && score >= 2 && isPrime[score]) {
                        const existing = primeScoreEarliest.get(score);
                        if (!existing || item.time < existing.time || (item.time === existing.time && item.id < existing.id)) {
                            primeScoreEarliest.set(score, { id: item.id, score, time: item.time });
                        }
                    }
                }
            } catch (e) { /* ignore */ }
        });

        rl.on('close', resolve);
    });
};

(async () => {
    for (const [idx, file] of files.entries()) {
        process.stdout.write(`\rParsing file ${idx+1}/${files.length}: ${file}`);
        await processFile(file);
    }
    console.log(`\nFound ${collectedPrimes.length} prime items.`);
    const idToPrime = new Map(collectedPrimes.map(item => [item.id, item]));
    for (const entry of primeScoreEarliest.values()) {
        const item = idToPrime.get(entry.id);
        if (!item) continue;
        const suffix = `posts:${entry.score}-${entry.time}`;
        item.pt = item.pt ? `${item.pt},${suffix}` : suffix;
    }

    // 4. SORT & SHARD
    console.log(`[4/6] Sorting and Writing Shards...`);
    
    collectedPrimes.sort((a, b) => a.id - b.id);

    const manifest = {
        totalPrimes: collectedPrimes.length,
        shardSize: SHARD_SIZE,
        maxId: collectedPrimes[collectedPrimes.length - 1].id,
        generatedAt: Date.now()
    };
    fs.writeFileSync('./docs/manifest.json', JSON.stringify(manifest));

    let currentShard = -1;
    let db = null;
    let insertStmt = null;

    // Helper to switch DBs
    const openDb = (shardIdx) => {
        if (db) db.close();
        
        const dbPath = `${OUTPUT_DIR}/shard_${shardIdx}.sqlite`;     // Define path
        if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);            // <--- ADD THIS
        
        db = new Database(dbPath);
        db.exec("CREATE TABLE items (idx INTEGER PRIMARY KEY, id INTEGER, title TEXT, user TEXT, score INTEGER, time INTEGER, type TEXT, prime_type TEXT);");
        db.exec("CREATE INDEX idx_prime_type ON items(prime_type);");
        insertStmt = db.prepare("INSERT INTO items (idx, id, title, user, score, time, type, prime_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
        db.exec("BEGIN");
    };

    openDb(0);
    currentShard = 0;
    
    collectedPrimes.forEach((item, index) => {
        const shardNeeded = Math.floor(index / SHARD_SIZE);
        
        if (shardNeeded !== currentShard) {
            db.exec("COMMIT");
            openDb(shardNeeded);
            currentShard = shardNeeded;
        }

        insertStmt.run(index, item.id, item.t, item.u, item.s, item.d, item.ty, item.pt);
    });

    db.exec("COMMIT");
    db.close();

    console.log("Success! Shards rebuilt with text snippets.");

    // Auto-build filter manifest
    console.log("\n[5/6] Building filter manifest...");
    require('child_process').execSync('node build-filter-manifest.js', { stdio: 'inherit' });

    if (GZIP_SHARDS) {
        console.log("\n[6/6] Gzipping shard files...");
        const shardFiles = fs.readdirSync(OUTPUT_DIR)
            .filter(f => f.match(/^shard_\d+\.sqlite$/))
            .sort((a, b) => {
                const numA = parseInt(a.match(/\d+/)[0]);
                const numB = parseInt(b.match(/\d+/)[0]);
                return numA - numB;
            });

        for (const shardFile of shardFiles) {
            const srcPath = path.join(OUTPUT_DIR, shardFile);
            const gzPath = `${srcPath}.gz`;
            const srcStat = fs.statSync(srcPath);
            let shouldZip = true;
            if (fs.existsSync(gzPath)) {
                const gzStat = fs.statSync(gzPath);
                if (gzStat.mtimeMs >= srcStat.mtimeMs && gzStat.size > 0) shouldZip = false;
            }
            if (!shouldZip) continue;
            process.stdout.write(`  gzip ${shardFile}... `);
            const gzBytes = gzipFileSync(srcPath, gzPath);
            process.stdout.write(`${(gzBytes / 1024 / 1024).toFixed(2)}MB\n`);
        }
    }
})();
