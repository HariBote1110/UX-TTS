const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createAudioResource, StreamType } = require('@discordjs/voice');
const { getCache, insertCache, deleteCacheEntry, getAllCacheEntries } = require('./database');
const { incrementCache } = require('./utils/statsManager'); 

const { VOICEVOX_API_URL, MAX_CACHE_SIZE_MB } = process.env;
const maxCacheSize = (parseInt(MAX_CACHE_SIZE_MB, 10) || 1024) * 1024 * 1024;
const CACHE_DIR = path.join(__dirname, 'audio_cache');

if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// --- ハッシュ生成関数 ---
function generateHash(text, speakerId, speed, pitch) {
    return crypto.createHash('md5').update(`${text}:${speakerId}:${speed}:${pitch}`).digest('hex');
}

/**
 * 音声リソースを取得する (キャッシュにあればそれを、なければ生成して保存)
 */
async function getAudioResource(text, speakerId, speed, pitch) {
    const hash = generateHash(text, speakerId, speed, pitch);
    
    // 1. キャッシュ確認
    const cachedFilePath = getCache(hash, speakerId, speed, pitch);
    if (cachedFilePath && fs.existsSync(cachedFilePath)) {
        // console.log(`[Cache] Hit: ${text.substring(0, 10)}...`);
        incrementCache(true); // ★ キャッシュヒットカウント
        return createAudioResource(cachedFilePath, { inputType: StreamType.Arbitrary });
    }

    // console.log(`[Cache] Miss: ${text.substring(0, 10)}... Generating...`);
    incrementCache(false); // ★ キャッシュミスカウント

    // 2. 音声合成 (VOICEVOX)
    try {
        const queryParams = new URLSearchParams({ text: text, speaker: speakerId });
        const queryRes = await fetch(`${VOICEVOX_API_URL}/audio_query?${queryParams}`, { method: 'POST' });
        if (!queryRes.ok) throw new Error(`Query failed: ${queryRes.statusText}`);
        const queryJson = await queryRes.json();
        
        queryJson.speedScale = speed;
        queryJson.pitchScale = pitch;

        const synthRes = await fetch(`${VOICEVOX_API_URL}/synthesis?speaker=${speakerId}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(queryJson)
        });
        if (!synthRes.ok) throw new Error(`Synthesis failed: ${synthRes.statusText}`);

        // 3. ファイル保存 & キャッシュ登録
        const buffer = await synthRes.arrayBuffer();
        const filePath = path.join(CACHE_DIR, `${hash}.wav`);
        fs.writeFileSync(filePath, Buffer.from(buffer));
        
        const fileSize = fs.statSync(filePath).size;
        insertCache(hash, speakerId, speed, pitch, filePath, fileSize);

        return createAudioResource(filePath, { inputType: StreamType.Arbitrary });

    } catch (error) {
        console.error('getAudioResource Error:', error);
        return null;
    }
}

/**
 * キャッシュ容量をチェックし、古いものを削除
 */
function sweepCache() {
    try {
        let currentSize = 0;
        const entries = getAllCacheEntries();
        
        // 合計サイズ計算
        for (const entry of entries) {
            if (fs.existsSync(entry.file_path)) {
                currentSize += entry.file_size;
            } else {
                deleteCacheEntry(entry.file_path);
            }
        }

        // 上限を超えていれば古い順に削除
        if (currentSize > maxCacheSize) {
            console.log(`キャッシュ容量超過 (${(currentSize/1024/1024).toFixed(2)}MB / ${(maxCacheSize/1024/1024).toFixed(2)}MB). 掃除を開始します...`);
            let deletedSize = 0;
            
            // 後ろから処理することで「古い順」に削除 (DBのSELECTがDESCの場合)
            for (let i = entries.length - 1; i >= 0; i--) {
                const entry = entries[i];
                if (currentSize <= maxCacheSize) break; 

                try {
                    if (fs.existsSync(entry.file_path)) {
                        fs.unlinkSync(entry.file_path);
                    }
                    deleteCacheEntry(entry.file_path);
                    currentSize -= entry.file_size;
                    deletedSize += entry.file_size;
                } catch (e) {
                    console.error(`キャッシュ削除失敗: ${entry.file_path}`, e);
                }
            }
            console.log(`キャッシュ掃除完了: ${(deletedSize/1024/1024).toFixed(2)}MB 削除しました。`);
        }
    } catch (e) {
        console.error('sweepCache Error:', e);
    }
}

module.exports = { getAudioResource, sweepCache };