const { createAudioResource, StreamType } = require('@discordjs/voice');
const { Readable } = require('stream');
const axios = require('axios');
const fs = require('fs');
const { sendErrorLog } = require('../errorLogger');
// ★修正: recordLatency をインポート
const { incrementCache, recordLatency } = require('../utils/statsManager');
const engineSelector = require('../utils/engineSelector');
const characterStats = require('../utils/characterStats');
const easterEggManager = require('../utils/easterEggManager');

// ==========================================
// ★ Layer A Synthesizer 設定
// ==========================================
const CACHE_ENABLED = true;
const TIMEOUT_MS = 10000;
const MAX_RETRIES = 3;
const RACE_INTERVAL = 15;
// ==========================================

const CACHE_URL = process.env.CACHE_SERVICE_URL || '';
const API_KEY = process.env.TTS_WORKER_KEY || '';

let requestCounter = 0;

// ==========================================
// ★ テキスト事前サニタイズ
// ==========================================
/**
 * 合成前のテキストを正規化する
 * - 孤立サロゲートを除去 (URI malformed 防止)
 * - OJT モード時は BMP 外文字・絵文字記号も除去 (JPCommonLabel_make エラー防止)
 * @param {string} text
 * @param {boolean} isOjt
 * @returns {string} サニタイズ済みテキスト
 */
function sanitiseText(text, isOjt) {
    // 孤立サロゲートを除去 (高位: \uD800-\uDBFF, 低位: \uDC00-\uDFFF)
    let result = text
        .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
        .replace(/[\uFFFE\uFFFF]/g, '');

    if (isOjt) {
        // OJT は BMP 外の文字・絵文字関連記号を処理できないため除去
        result = result
            .replace(/[\u{10000}-\u{10FFFF}]/gu, '')              // BMP外の全文字
            .replace(/[\u{2600}-\u{27BF}\u{2B50}-\u{2B55}]/gu, '') // Misc Symbols, Dingbats
            .replace(/[\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu, ''); // 異体字セレクタ, ZWJ, 囲みキーキャップ
    }

    return result.trim();
}

async function synthesize(text, options) {
    const { returnBuffer = false, logEnabled = true, userId, useOjt } = options;

    // ==========================================
    // ★ テキスト事前チェック
    // ==========================================
    const sanitised = sanitiseText(text, !!useOjt);
    if (!sanitised) {
        if (logEnabled) console.log(`[Synthesizer] ⏭️ Skipped: text is empty after sanitisation (useOjt=${!!useOjt})`);
        return null;
    }

    // ==========================================
    // ★ イースターエッグチェック (最優先)
    // ==========================================
    if (userId) {
        const easterEgg = easterEggManager.findMatch(text, userId);
        if (easterEgg) {
            if (logEnabled) console.log(`[Synthesizer] 🥚 Easter Egg triggered: ${easterEgg.description}`);

            if (returnBuffer) {
                // バッファとして返す場合はファイルを読み込んで返す
                return fs.readFileSync(easterEgg.audioPath);
            }
            return easterEggManager.createEasterEggResource(easterEgg.audioPath);
        }
    }

    if (useOjt) {
        return await synthesizeOjt(sanitised, options);
    } else {
        return await synthesizeVoicevox(sanitised, options);
    }
}

async function synthesizeOjt(text, options) {
    const { guildId, logEnabled = true, returnBuffer = false } = options;

    if (logEnabled) console.log(`[Synthesizer] ⏩ Cache Skip (OJT or Disabled)`);

    const result = await generateFromWorker(text, options);
    if (!result) return null;

    const { audioBuffer, generationDuration } = result;

    if (audioBuffer && generationDuration > 0) {
        recordLatency(guildId, generationDuration, 'Worker', text.length || 1);
    }

    if (returnBuffer) return audioBuffer;
    return createResourceFromBuffer(audioBuffer);
}

async function synthesizeVoicevox(text, options) {
    const { guildId, speakerId, speed, pitch, logEnabled = true, returnBuffer = false } = options;
    const canCache = CACHE_ENABLED;
    let shouldSaveToCache = false;

    // --- 1. キャッシュ検索 (Layer-B) ---
    if (canCache) {
        try {
            const cacheStart = Date.now();
            if (logEnabled) console.log(`[Synthesizer] 🔍 Searching Cache...`);

            const cacheRes = await axios.post(`${CACHE_URL}/cache/search`, {
                text, speakerId, speed, pitch
            }, {
                headers: { 'Authorization': `Bearer ${API_KEY}` },
                responseType: 'arraybuffer',
                timeout: 500,
                validateStatus: (status) => status === 200 || status === 404
            });

            if (cacheRes.status === 200) {
                incrementCache(true);
                const duration = Date.now() - cacheStart;

                // ★ キャッシュヒット時のレイテンシを記録
                recordLatency(guildId, duration, 'Cache', text.length || 1);

                if (logEnabled) console.log(`[Synthesizer] ✅ Cache HIT (${duration}ms)`);
                if (returnBuffer) return cacheRes.data;
                return createResourceFromBuffer(cacheRes.data);
            } else if (cacheRes.status === 404) {
                incrementCache(false);
                if (logEnabled) console.log(`[Synthesizer] 💨 Cache MISS`);
                try {
                    const jsonStr = Buffer.from(cacheRes.data).toString('utf8');
                    const jsonData = JSON.parse(jsonStr);
                    if (jsonData.shouldCache) shouldSaveToCache = true;
                } catch (e) {
                    console.error(`[Synthesizer] JSON Parse Error: ${e.message}`);
                }
            }
        } catch (e) {
            if (logEnabled) console.warn(`[Synthesizer] ⚠️ Cache Check Error: ${e.message}`);
            incrementCache(false);
        }
    } else {
        if (logEnabled) console.log(`[Synthesizer] ⏩ Cache Skip (OJT or Disabled)`);
    }

    // --- 2. 新規生成 (Layer-C) ---
    const result = await generateFromWorker(text, options);
    if (!result) return null;

    const { audioBuffer, generationDuration } = result;

    // ★ 生成成功時のレイテンシを記録 (Source: Worker)
    // ここで記録することで、キュー待ち時間を含まない純粋な生成時間を保存できる
    if (audioBuffer && generationDuration > 0) {
        recordLatency(guildId, generationDuration, 'Worker', text.length || 1);

        // ★ キャラクター使用統計を記録 (VOICEVOXのみ)
        if (speakerId) {
            characterStats.recordUsage(speakerId);
        }
    }

    // --- 3. キャッシュ保存 ---
    if (canCache && shouldSaveToCache && audioBuffer) {
        if (logEnabled) console.log(`[Synthesizer] 💾 Saving to Cache...`);
        saveToCache(text, speakerId, speed, pitch, audioBuffer).catch(err => {
            if (logEnabled) console.warn(`[Synthesizer] Cache Save Warning: ${err.message}`);
        });
    }

    if (returnBuffer) return audioBuffer;
    return createResourceFromBuffer(audioBuffer);
}

async function generateFromWorker(text, options) {
    const { client, guildId, speakerId, logEnabled = true } = options;

    requestCounter++;

    // 利用可能なワーカー一覧
    const availableWorkers = engineSelector.getAvailableWorkers();

    // レース条件: 10回に1回 かつ 複数のワーカーがいる場合
    const isRace = (requestCounter % RACE_INTERVAL === 0) && (availableWorkers.length > 1);

    let audioBuffer = null;
    let generationDuration = 0; // 生成時間保持用

    if (isRace) {
        // ==========================================
        // 🏎️ Speed Race Mode (Broadcast)
        // ==========================================
        if (logEnabled) console.log(`[Synthesizer] 🏁 Speed Race triggered! Broadcasting to ${availableWorkers.length} workers...`);

        const promises = availableWorkers.map(url =>
            performRequest(url, text, options, true).catch(err => { throw err; })
        );

        try {
            // 最速で成功した結果を取得
            const result = await Promise.any(promises);
            audioBuffer = result.data;
            generationDuration = result.duration;

            if (logEnabled) console.log(`[Synthesizer] 🏆 Race finished. Fastest: ${generationDuration}ms`);
        } catch (aggError) {
            console.error(`[Synthesizer] ❌ All workers failed in Race mode.`);
            handleError(new Error('All workers failed in Race mode'), client, guildId, logEnabled);
            return null;
        }

    } else {
        // ==========================================
        // 🔄 Normal Mode (Single + Failover)
        // ==========================================
        let attempts = 0;
        const excludeWorkers = [];
        let lastError = null;

        while (attempts < MAX_RETRIES) {
            attempts++;
            // ★ speakerIdを渡してルーティング
            const workerUrl = engineSelector.select(excludeWorkers, speakerId);

            if (!workerUrl) {
                const msg = 'No available TTS Workers found.';
                console.error(`[${guildId}] ${msg}`);
                if (attempts === 1) handleError(new Error(msg), client, guildId, logEnabled);
                break;
            }

            if (logEnabled) console.log(`[Synthesizer] 🔄 Assigned to Worker: ${workerUrl} (Attempt ${attempts})`);

            try {
                const result = await performRequest(workerUrl, text, options, false);
                audioBuffer = result.data;
                generationDuration = result.duration;
                break; // 成功

            } catch (error) {
                console.warn(`[Synthesizer] ⚠️ Worker ${workerUrl} failed. Switching...`);
                excludeWorkers.push(workerUrl);
                lastError = error;
            }
        }

        if (!audioBuffer) {
            handleError(lastError || new Error('All retries failed'), client, guildId, logEnabled);
            return null;
        }
    }

    return { audioBuffer, generationDuration };
}

/**
 * performRequest: 戻り値を { data, duration } に変更
 */
async function performRequest(workerUrl, text, options, isRace) {
    const { speakerId, speed, pitch, useOjt, logEnabled = true } = options;
    const startTime = Date.now();

    try {
        engineSelector.startRequest(workerUrl);
        const genRes = await axios.post(`${workerUrl}/synthesize`, {
            text, speakerId, speed, pitch, useOjt
        }, {
            headers: { 'Authorization': `Bearer ${API_KEY}` },
            responseType: 'arraybuffer',
            timeout: TIMEOUT_MS
        });

        const duration = Date.now() - startTime;
        const charCount = text.length || 1;
        const speedMsChar = (duration / charCount).toFixed(2);

        if (logEnabled) {
            const prefix = isRace ? `[Synthesizer] 🏎️ ${workerUrl}` : `[Synthesizer] ⚡ Worker Response`;
            console.log(`${prefix}: ${duration}ms (${speedMsChar} ms/char)`);
        }

        // 成功記録
        engineSelector.record(workerUrl, duration, charCount);

        // ★ データと時間をセットで返す
        return { data: genRes.data, duration };

    } catch (error) {
        const duration = Date.now() - startTime;
        const statusCode = error.response ? error.response.status : null;

        // 400 はコンテンツ起因のエラーのためワーカーを DOWN 扱いにしない
        // 5xx やネットワークエラーのみ失敗報告する
        if (statusCode !== 400) {
            engineSelector.reportFailure(workerUrl);
        }

        const isTimeout = error.code === 'ECONNABORTED';
        const reason = isTimeout ? 'Timeout' : error.message;

        if (logEnabled && isRace) {
            console.warn(`[Synthesizer] 🏎️ ${workerUrl} failed after ${duration}ms: ${reason}`);
        }
        throw error;
    } finally {
        engineSelector.endRequest(workerUrl);
    }
}

function createResourceFromBuffer(buffer) {
    const stream = Readable.from(Buffer.from(buffer));
    return createAudioResource(stream, { inputType: StreamType.Arbitrary, inlineVolume: true });
}

async function saveToCache(text, speakerId, speed, pitch, buffer) {
    const base64 = Buffer.from(buffer).toString('base64');
    await axios.post(`${CACHE_URL}/cache/save`, {
        text, speakerId, speed, pitch, audioBase64: base64
    }, {
        headers: { 'Authorization': `Bearer ${API_KEY}` },
        timeout: 2000
    });
}

function handleError(error, client, guildId, logEnabled) {
    let msg = error.message;
    let details = null;
    let workerUrl = null;

    if (error.response) {
        msg = `Worker Error (${error.response.status})`;
        // ★ Layer-C のレスポンスボディから詳細を抽出
        try {
            const responseData = error.response.data;
            if (responseData) {
                if (Buffer.isBuffer(responseData) || responseData instanceof ArrayBuffer) {
                    const jsonStr = Buffer.from(responseData).toString('utf8');
                    const parsed = JSON.parse(jsonStr);
                    details = parsed.details || parsed.error || jsonStr;
                } else if (typeof responseData === 'object') {
                    details = responseData.details || responseData.error || JSON.stringify(responseData);
                } else {
                    details = String(responseData);
                }
            }
        } catch (_) { /* パース失敗時は details = null のまま */ }
        // リクエスト先の URL を記録
        if (error.config && error.config.url) {
            workerUrl = error.config.url.replace(/\/synthesize$/, '');
        }
    } else if (error.code === 'ECONNREFUSED') {
        msg = 'Connection Refused';
        if (error.config && error.config.url) {
            workerUrl = error.config.url.replace(/\/synthesize$/, '');
        }
    }

    const statusCode = error.response ? error.response.status : null;

    // 400 はコンテンツ起因 (テキスト問題) のため通常ログのみ、Discord 通知はしない
    if (statusCode === 400) {
        if (logEnabled !== false) {
            console.warn(`[${guildId}] Synthesize Skipped (400): ${details || msg}`);
        }
        return;
    }

    console.error(`[${guildId}] Synthesize Failed: ${msg}${details ? ` | Details: ${details}` : ''}`);
    if (client && error.code !== 'ECONNREFUSED') {
        sendErrorLog(client, new Error(msg), { place: 'Synthesizer', guildId, details, workerUrl });
    }
}

module.exports = { synthesize };
