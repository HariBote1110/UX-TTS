require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { sanitizeSynthesisText } = require('./lib/sanitizeSynthesisText');

const STATS_FILE = path.join(__dirname, 'character_stats.json');
const VVX_CONTAINER_NAME = process.env.VOICEVOX_CONTAINER_NAME;
const RESTART_INTERVAL_MIN = parseInt(process.env.RESTART_INTERVAL_MINUTES || '60', 10);

let charStats = {};
let activeRequests = 0;

function loadStats() {
    try {
        if (fs.existsSync(STATS_FILE)) {
            const data = fs.readFileSync(STATS_FILE, 'utf8');
            charStats = JSON.parse(data);
        }
    } catch (e) {
        console.error('[Stats] Failed to load stats:', e.message);
    }
}

function saveStats() {
    try {
        fs.writeFileSync(STATS_FILE, JSON.stringify(charStats, null, 2));
    } catch (e) {
        console.error('[Stats] Failed to save stats:', e.message);
    }
}

async function warmUpEngine() {
    const VOICEVOX_API_URL = process.env.VOICEVOX_API_URL || '';
    const API_KEY = process.env.API_KEY;
    const LAYER_A_URL = process.env.LAYER_A_URL;
    const WORKER_SELF_URL = process.env.WORKER_SELF_URL;

    console.log('[WarmUp] 🔥 Starting engine warm-up sequence...');

    let ready = false;
    for (let i = 0; i < 12; i++) {
        try {
            await axios.get(`${VOICEVOX_API_URL}/version`, { timeout: 2000 });
            ready = true;
            break;
        } catch (e) {
            console.log(`[WarmUp] Waiting for VOICEVOX engine... (${i + 1}/12)`);
            await new Promise(r => setTimeout(r, 5000));
        }
    }

    if (!ready) {
        console.error('[WarmUp] ❌ Engine did not start in time. Aborting.');
        return;
    }
    console.log('[WarmUp] ✅ VOICEVOX engine is ready.');

    let targets = [];
    if (LAYER_A_URL && WORKER_SELF_URL && API_KEY) {
        try {
            const encodedUrl = encodeURIComponent(WORKER_SELF_URL);
            const response = await axios.get(
                `${LAYER_A_URL}/api/routing/worker/${encodedUrl}/characters`,
                {
                    headers: { 'x-api-key': API_KEY },
                    timeout: 5000
                }
            );

            if (response.data && response.data.characters) {
                targets = response.data.characters;
                console.log(`[WarmUp] 📡 Fetched ${targets.length} characters from Layer-A: [${targets.join(', ')}]`);
            }
        } catch (e) {
            console.warn(`[WarmUp] ⚠️ Could not fetch characters from Layer-A: ${e.message}`);
            console.log('[WarmUp] ➡️ Falling back to local stats...');
        }
    }

    if (targets.length === 0) {
        const sortedSpeakers = Object.entries(charStats)
            .sort(([, countA], [, countB]) => countB - countA)
            .map(([id]) => parseInt(id, 10));
        targets = sortedSpeakers.slice(0, 3);

        if (targets.length === 0) {
            console.log('[WarmUp] ℹ️ No character data available. Skipping warm-up.');
            console.log('[WarmUp] ✨ Warm-up sequence complete.');
            return;
        }
        console.log(`[WarmUp] 📊 Using local stats. Targets: [${targets.join(', ')}]`);
    }

    console.log(`[WarmUp] 🎯 Warming up ${targets.length} characters...`);
    for (const speakerId of targets) {
        try {
            const queryRes = await axios.post(
                `${VOICEVOX_API_URL}/audio_query`,
                null,
                { params: { text: '準備', speaker: speakerId } }
            );
            await axios.post(
                `${VOICEVOX_API_URL}/synthesis`,
                queryRes.data,
                {
                    params: { speaker: speakerId },
                    responseType: 'arraybuffer'
                }
            );
            console.log(`[WarmUp] ✅ Speaker ${speakerId} is ready.`);
        } catch (e) {
            console.warn(`[WarmUp] ⚠️ Failed to warm up speaker ${speakerId}: ${e.message}`);
        }
    }

    console.log('[WarmUp] ✨ Warm-up sequence complete.');
}

/**
 * @param {object} [overrides]
 * @param {string} [overrides.apiKey]
 * @param {string} [overrides.voicelabsUrl]
 * @param {string} [overrides.openjtalkUrl]
 * @param {boolean} [overrides.skipStatsPersistence] — テスト用: VOICEVOX 合成時に char_stats をディスクへ書かない
 */
function buildApp(overrides = {}) {
    const API_KEY = overrides.apiKey ?? process.env.API_KEY;
    if (!API_KEY) {
        throw new Error('API_KEY is required');
    }
    const VOICEVOX_API_URL = overrides.voicelabsUrl ?? process.env.VOICEVOX_API_URL ?? '';
    const OPENJTALK_API_URL = overrides.openjtalkUrl ?? process.env.OPENJTALK_API_URL;
    const skipStatsPersistence = Boolean(overrides.skipStatsPersistence);

    const app = express();
    app.use(cors());
    app.use(express.json());

    app.use((req, res, next) => {
        let finished = false;
        const isSynthesize = req.path === '/synthesize' && req.method === 'POST';

        if (isSynthesize) {
            activeRequests++;
        }

        const start = Date.now();

        const cleanup = () => {
            if (finished) return;
            finished = true;

            const duration = Date.now() - start;
            console.log(`[REQ] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${duration}ms)`);

            if (isSynthesize) {
                activeRequests = Math.max(0, activeRequests - 1);
            }
        };

        res.on('finish', cleanup);
        res.on('close', cleanup);
        next();
    });

    const authenticate = (req, res, next) => {
        const authHeader = req.headers['authorization'];
        if (!authHeader || authHeader !== `Bearer ${API_KEY}`) {
            console.warn(`[AUTH FAILED] IP: ${req.ip}`);
            return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
    };

    app.get('/', (req, res) => {
        res.json({ status: 'ok', service: 'Layer-C (TTS Worker)' });
    });

    app.get('/version', (req, res) => {
        res.json({ status: 'ok', version: '1.2.0-Beta-1e' });
    });

    app.get('/status', (req, res) => {
        res.json({
            status: 'ok',
            activeRequests,
            autoRestart: {
                enabled: !!VVX_CONTAINER_NAME,
                intervalMin: RESTART_INTERVAL_MIN,
                container: VVX_CONTAINER_NAME
            }
        });
    });

    app.post('/synthesize', authenticate, async (req, res) => {
        const { text, speakerId = 1, speed = 1.0, pitch = 0.0, useOjt = false } = req.body;

        if (!text) return res.status(400).json({ error: 'Text is required' });

        const sanitiseResult = sanitizeSynthesisText(text, useOjt);
        if (!sanitiseResult.ok) {
            return res.status(400).json({ error: 'Text is empty after sanitisation' });
        }
        const sanitisedText = sanitiseResult.text;

        if (!useOjt) {
            charStats[speakerId] = (charStats[speakerId] || 0) + 1;
            if (!skipStatsPersistence) {
                saveStats();
            }
        }

        try {
            let audioBuffer;
            let contentType;

            if (useOjt) {
                if (!OPENJTALK_API_URL) throw new Error('Open JTalk API URL is not configured');

                const response = await axios.post(OPENJTALK_API_URL, { text: sanitisedText }, {
                    responseType: 'arraybuffer',
                    timeout: 10000
                });

                audioBuffer = response.data;
                contentType = response.headers['content-type'] || 'audio/wav';
            } else {
                const queryRes = await axios.post(
                    `${VOICEVOX_API_URL}/audio_query`,
                    null,
                    { params: { text: sanitisedText, speaker: speakerId } }
                );

                const query = queryRes.data;
                query.speedScale = speed;
                query.pitchScale = pitch;
                query.volumeScale = 1.0;
                query.outputSamplingRate = 48000;

                const synthesisRes = await axios.post(
                    `${VOICEVOX_API_URL}/synthesis`,
                    query,
                    {
                        params: { speaker: speakerId },
                        responseType: 'arraybuffer',
                        headers: { 'Content-Type': 'application/json', 'Accept': 'audio/wav' }
                    }
                );

                audioBuffer = synthesisRes.data;
                contentType = 'audio/wav';
            }

            res.set('Content-Type', contentType);
            res.set('Content-Length', audioBuffer.length);
            res.send(Buffer.from(audioBuffer));
        } catch (error) {
            let details = error.message;
            let status = 500;

            if (error.response) {
                status = error.response.status;
                try {
                    const data = error.response.data;
                    if (data) {
                        if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
                            const parsed = JSON.parse(Buffer.from(data).toString('utf8'));
                            details = parsed.detail || parsed.message || JSON.stringify(parsed);
                        } else if (typeof data === 'object') {
                            details = data.detail || data.message || JSON.stringify(data);
                        } else {
                            details = String(data);
                        }
                    }
                } catch (_) { /* keep error.message */ }
            }

            console.error(`[TTS Error] ${status} | ${details}`);
            res.status(status).json({ error: 'Synthesis failed', details });
        }
    });

    return app;
}

function scheduleNextRestart() {
    if (!VVX_CONTAINER_NAME) return;

    const jitterMinutes = Math.random() * (RESTART_INTERVAL_MIN * 0.2);
    const delayMs = (RESTART_INTERVAL_MIN + jitterMinutes) * 60 * 1000;

    console.log(`[AutoRestart] Next engine restart scheduled in ${(delayMs / 60000).toFixed(1)} minutes.`);

    setTimeout(() => {
        tryRestartEngine();
    }, delayMs);
}

function tryRestartEngine() {
    if (activeRequests > 0) {
        console.log(`[AutoRestart] Busy (Active requests: ${activeRequests}). Retrying in 10s...`);
        setTimeout(tryRestartEngine, 10000);
        return;
    }

    console.log(`[AutoRestart] ♻️ Restarting VOICEVOX container: ${VVX_CONTAINER_NAME}...`);

    execFile('docker', ['restart', VVX_CONTAINER_NAME], (error, stdout, stderr) => {
        if (error) {
            console.error(`[AutoRestart] ❌ Failed to restart container: ${error.message}`);
        } else {
            console.log(`[AutoRestart] ✅ Container restarted successfully.`);
            warmUpEngine();
        }
        scheduleNextRestart();
    });
}

function startServer() {
    if (!process.env.API_KEY) {
        console.error('FATAL ERROR: API_KEY is not set in environment variables.');
        process.exit(1);
    }

    loadStats();
    const app = buildApp();
    const PORT = process.env.PORT || 4000;
    const VOICEVOX_API_URL = process.env.VOICEVOX_API_URL || '';

    app.listen(PORT, '0.0.0.0', () => {
        console.log(`🔊 Layer-C (TTS Worker) is running on port ${PORT}`);
        console.log(`   - Voicevox: ${VOICEVOX_API_URL}`);
        console.log(`   - AutoRestart: ${VVX_CONTAINER_NAME ? `Enabled (Interval: ~${RESTART_INTERVAL_MIN}m)` : 'Disabled'}`);

        if (VVX_CONTAINER_NAME) {
            scheduleNextRestart();
        }

        warmUpEngine();
    });
}

if (require.main === module) {
    startServer();
}

module.exports = { buildApp };
