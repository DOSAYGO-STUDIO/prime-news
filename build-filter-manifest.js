#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SHARDS_DIR = './docs/shards';
const OUTPUT_FILE = './docs/filter-manifest.json';

// All filter types we track
const FILTER_TYPES = [
    'mersenne', 'fermat', 'germain', 'palindrome',
    'pkk', 'pk2', 'pk4', 'pk6', 'pk8', 'pk10', 'pk12',
    'pkek2', 'pkesqrt'
];

// Build manifest from existing shards
console.log('Building filter manifest from shards...');

const shardFiles = fs.readdirSync(SHARDS_DIR)
    .filter(f => f.match(/^shard_\d+\.sqlite$/))
    .sort((a, b) => {
        const numA = parseInt(a.match(/\d+/)[0]);
        const numB = parseInt(b.match(/\d+/)[0]);
        return numA - numB;
    });

console.log(`Found ${shardFiles.length} shards`);

// Initialize manifest structure
const manifest = {};
for (const filter of FILTER_TYPES) {
    manifest[filter] = {
        total: 0,
        shards: []
    };
}

// Process each shard
for (const shardFile of shardFiles) {
    const shardIdx = parseInt(shardFile.match(/\d+/)[0]);
    const dbPath = path.join(SHARDS_DIR, shardFile);
    const db = new Database(dbPath, { readonly: true });

    process.stdout.write(`\rProcessing shard ${shardIdx}...`);

    for (const filter of FILTER_TYPES) {
        // Build the WHERE clause based on filter type
        let whereClause;
        if (filter === 'mersenne' || filter === 'fermat' || filter === 'germain' || filter === 'palindrome') {
            whereClause = `prime_type LIKE '%${filter}%'`;
        } else if (filter === 'pkk') {
            whereClause = `prime_type LIKE '%pkk:%'`;
        } else if (filter.startsWith('pk') && /^pk\d+$/.test(filter)) {
            whereClause = `prime_type LIKE '%${filter}:%'`;
        } else if (filter === 'pkek2') {
            whereClause = `prime_type LIKE '%pkek2:%'`;
        } else if (filter === 'pkesqrt') {
            whereClause = `prime_type LIKE '%pkesqrt:%'`;
        } else {
            continue;
        }

        const result = db.prepare(`SELECT COUNT(*) as count FROM items WHERE ${whereClause}`).get();
        const count = result.count;

        if (count > 0) {
            const cumulative = manifest[filter].total + count;
            manifest[filter].shards.push({
                idx: shardIdx,
                count: count,
                cumulative: cumulative
            });
            manifest[filter].total = cumulative;
        }
    }

    db.close();
}

console.log('\n\nFilter totals:');
for (const filter of FILTER_TYPES) {
    console.log(`  ${filter}: ${manifest[filter].total} items across ${manifest[filter].shards.length} shards`);
}

// Write manifest
fs.writeFileSync(OUTPUT_FILE, JSON.stringify(manifest, null, 2));
console.log(`\nWritten to ${OUTPUT_FILE}`);
