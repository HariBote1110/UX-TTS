require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const cors = require('cors');
const fs = require('fs');
const { generateCacheHash } = require('./lib/generateCacheHash');

/**
 * @param {object} [overrides]
 * @param {string} overrides.apiKey
 * @param {string} overrides.dbDir
 * @param {string} overrides.cacheDir
 * @param {number} [overrides.maxCacheSizeMb]
 * @param {number} [overrides.cacheThreshold]
 * @param {boolean} [overrides.debugLog]
 * @param {boolean} [overrides.skipBackgroundTimers] — test用: setInterval を登録しない
 */
function buildApp(overrides = {}) {
    const API_KEY = overrides.apiKey ?? process.env.API_KEY;
    if (!API_KEY) {
        throw new Error('API_KEY is required');
    }

    const MAX_CACHE_SIZE_MB = overrides.maxCacheSizeMb ?? parseInt(process.env.MAX_CACHE_SIZE_MB || '1024', 10);
    const MAX_CACHE_BYTES = MAX_CACHE_SIZE_MB * 1024 * 1024;
    const CACHE_THRESHOLD = overrides.cacheThreshold ?? 2;
    let debugMode = overrides.debugLog ?? (process.env.DEBUG_LOG === 'true');
    const skipBackgroundTimers = Boolean(overrides.skipBackgroundTimers);

    const DB_DIR = overrides.dbDir ?? path.join(__dirname, 'database');
    const CACHE_DIR = overrides.cacheDir ?? path.join(__dirname, 'audio_cache');

    if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

    const db = new Database(path.join(DB_DIR, 'cache.sqlite3'));

    db.exec(`
  CREATE TABLE IF NOT EXISTS audio_cache (
    text_hash TEXT,
    speaker_id INTEGER,
    speed REAL,
    pitch REAL,
    file_path TEXT PRIMARY KEY,
    last_accessed INTEGER,
    file_size INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_text_hash ON audio_cache(text_hash);
  CREATE INDEX IF NOT EXISTS idx_last_accessed ON audio_cache(last_accessed);
`);

    const requestCounters = new Map();

    function log(message) {
        if (debugMode) console.log(`[${new Date().toLocaleTimeString()}] ${message}`);
    }

    if (!skipBackgroundTimers) {
        setInterval(() => {
            requestCounters.clear();
            log('[System] Request counters cleared.');
        }, 60 * 60 * 1000);
    }

    const app = express();

    const authenticate = (req, res, next) => {
        if (req.path.startsWith('/debug')) return next();
        const authHeader = req.headers['authorization'];
        if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
    };

    function runCacheCleanup() {
        try {
            let currentSize = 0;
            const entries = db.prepare('SELECT file_path, file_size FROM audio_cache ORDER BY last_accessed ASC').all();

            const validEntries = [];
            for (const entry of entries) {
                const fileName = path.basename(entry.file_path);
                const currentPath = path.join(CACHE_DIR, fileName);

                if (fs.existsSync(currentPath)) {
                    currentSize += entry.file_size;
                    entry.currentPath = currentPath;
                    validEntries.push(entry);
                } else {
                    db.prepare('DELETE FROM audio_cache WHERE file_path = ?').run(entry.file_path);
                }
            }

            if (currentSize > MAX_CACHE_BYTES) {
                console.log(`[Cache Cleanup] Size limit exceeded (${(currentSize / 1024 / 1024).toFixed(2)}MB). Cleaning...`);
                let deletedCount = 0;

                for (const entry of validEntries) {
                    if (currentSize <= MAX_CACHE_BYTES) break;
                    try {
                        fs.unlinkSync(entry.currentPath);
                        db.prepare('DELETE FROM audio_cache WHERE file_path = ?').run(entry.file_path);
                        currentSize -= entry.file_size;
                        deletedCount++;
                    } catch (e) {
                        console.error(`[Cleanup Error] ${e.message}`);
                    }
                }
                console.log(`[Cache Cleanup] Deleted ${deletedCount} files.`);
            }
        } catch (e) {
            console.error('[Cache Cleanup Error]', e);
        }
    }

    runCacheCleanup();
    if (!skipBackgroundTimers) {
        setInterval(runCacheCleanup, 60 * 60 * 1000);
    }

    app.use(cors());
    app.use(express.json({ limit: '10mb' }));

    app.get('/debug/toggle', (req, res) => {
        debugMode = !debugMode;
        res.send(`Debug Log: ${debugMode}`);
    });

    app.post('/cache/search', authenticate, (req, res) => {
        const { text, speakerId, speed, pitch } = req.body;
        const hash = generateCacheHash(text, speakerId, speed, pitch);

        try {
            const row = db.prepare(`
            SELECT file_path FROM audio_cache 
            WHERE text_hash = ? AND speaker_id = ? AND speed = ? AND pitch = ?
        `).get(hash, speakerId, speed, pitch);

            if (row) {
                const fileName = path.basename(row.file_path);
                const realPath = path.join(CACHE_DIR, fileName);

                if (fs.existsSync(realPath)) {
                    db.prepare('UPDATE audio_cache SET last_accessed = ? WHERE file_path = ?').run(Date.now(), row.file_path);
                    log(`[HIT] "${text.substring(0, 10)}..."`);

                    const fileBuffer = fs.readFileSync(realPath);
                    res.set('Content-Type', 'audio/wav');
                    return res.send(fileBuffer);
                }
                db.prepare('DELETE FROM audio_cache WHERE file_path = ?').run(row.file_path);
            }

            const currentCount = (requestCounters.get(hash) || 0) + 1;
            requestCounters.set(hash, currentCount);

            const shouldCache = currentCount >= CACHE_THRESHOLD;

            log(`[MISS] "${text.substring(0, 10)}..." (Count: ${currentCount}/${CACHE_THRESHOLD})`);

            res.status(404).json({
                message: 'Not found',
                shouldCache,
            });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'DB Error' });
        }
    });

    app.post('/cache/save', authenticate, (req, res) => {
        const { text, speakerId, speed, pitch, audioBase64 } = req.body;
        if (!audioBase64) return res.status(400).json({ error: 'No data' });

        try {
            const hash = generateCacheHash(text, speakerId, speed, pitch);
            const fileName = `${hash}.wav`;
            const filePath = path.join(CACHE_DIR, fileName);
            const buffer = Buffer.from(audioBase64, 'base64');

            fs.writeFileSync(filePath, buffer);
            const fileSize = buffer.length;

            db.prepare(`
            INSERT OR REPLACE INTO audio_cache 
            (text_hash, speaker_id, speed, pitch, file_path, last_accessed, file_size)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(hash, speakerId, speed, pitch, filePath, Date.now(), fileSize);

            log(`[SAVED] "${text.substring(0, 10)}..."`);
            res.json({ success: true });
        } catch (err) {
            console.error(err);
            res.status(500).json({ error: 'Save Error' });
        }
    });

    return app;
}

function startServer() {
    const API_KEY = process.env.API_KEY;
    if (!API_KEY) {
        console.error('[Layer-B] API_KEY が設定されていません。');
        process.exit(1);
    }

    const PORT = process.env.PORT || 5501;
    const app = buildApp({
        apiKey: API_KEY,
        dbDir: path.join(__dirname, 'database'),
        cacheDir: path.join(__dirname, 'audio_cache'),
    });

    app.listen(PORT, () => {
        console.log(`💾 Layer-B (Cache) running on port ${PORT}`);
        console.log('   - Mode: File System + SQLite');
        console.log('   - Threshold: 2 hits to save');
    });
}

if (require.main === module) {
    startServer();
}

module.exports = { buildApp };
