/**
 * イースターエッグマネージャー
 * 特定の文字列が送信された時に、事前にペアリングされた音声ファイルを返す
 */
const fs = require('fs');
const path = require('path');
const { createAudioResource, StreamType } = require('@discordjs/voice');

const EASTER_EGGS_JSON = path.join(__dirname, '../data/easter_eggs.json');
const AUDIO_DIR = path.join(__dirname, '../audio_easter_eggs');

// メモリキャッシュ
let easterEggsData = null;
let lastLoadTime = 0;
const RELOAD_INTERVAL = 60000; // 1分ごとにリロード

/**
 * 設定ファイルを読み込む（キャッシュ付き）
 */
function loadConfig() {
    const now = Date.now();
    if (easterEggsData && (now - lastLoadTime) < RELOAD_INTERVAL) {
        return easterEggsData;
    }

    try {
        if (fs.existsSync(EASTER_EGGS_JSON)) {
            const raw = fs.readFileSync(EASTER_EGGS_JSON, 'utf8');
            easterEggsData = JSON.parse(raw);
            lastLoadTime = now;
        } else {
            easterEggsData = { enabled: false, entries: [], optOutUsers: [] };
        }
    } catch (e) {
        console.error('[EasterEgg] 設定ファイル読み込みエラー:', e.message);
        easterEggsData = { enabled: false, entries: [], optOutUsers: [] };
    }

    return easterEggsData;
}

/**
 * ユーザーがオプトアウトしているかチェック
 */
function isUserOptedOut(userId) {
    const config = loadConfig();
    return config.optOutUsers?.includes(userId) || false;
}

/**
 * ユーザーをオプトアウトリストに追加
 */
function addOptOut(userId) {
    const config = loadConfig();
    if (!config.optOutUsers) config.optOutUsers = [];
    if (!config.optOutUsers.includes(userId)) {
        config.optOutUsers.push(userId);
        saveConfig(config);
        return true;
    }
    return false;
}

/**
 * ユーザーをオプトアウトリストから削除
 */
function removeOptOut(userId) {
    const config = loadConfig();
    if (!config.optOutUsers) return false;
    const index = config.optOutUsers.indexOf(userId);
    if (index > -1) {
        config.optOutUsers.splice(index, 1);
        saveConfig(config);
        return true;
    }
    return false;
}

/**
 * 設定ファイルを保存
 */
function saveConfig(config) {
    try {
        fs.writeFileSync(EASTER_EGGS_JSON, JSON.stringify(config, null, 2), 'utf8');
        easterEggsData = config;
        lastLoadTime = Date.now();
    } catch (e) {
        console.error('[EasterEgg] 設定ファイル保存エラー:', e.message);
    }
}

/**
 * テキストを正規化（Unicode NFC + 波ダッシュ統一）
 * @param {string} text
 * @returns {string}
 */
function normalizeText(text) {
    if (!text) return '';
    // NFC正規化 + 波ダッシュの統一（WAVE DASH U+301C → FULLWIDTH TILDE U+FF5E）
    return text.normalize('NFC').replace(/\u301C/g, '\uFF5E');
}

/**
 * テキストがイースターエッグにマッチするかチェック（完全一致）
 * @param {string} text - 入力テキスト
 * @param {string} userId - ユーザーID
 * @returns {object|null} マッチした場合は { audioFile, description }、しなければ null
 */
function findMatch(text, userId) {
    const config = loadConfig();

    // 機能が無効、またはユーザーがオプトアウト済み
    if (!config.enabled || isUserOptedOut(userId)) {
        return null;
    }

    // 正規化してから完全一致でマッチング
    const normalizedInput = normalizeText(text);
    const match = config.entries?.find(entry => normalizeText(entry.trigger) === normalizedInput);

    if (match) {
        const audioPath = path.join(AUDIO_DIR, match.audioFile);
        if (fs.existsSync(audioPath)) {
            return {
                audioPath,
                description: match.description || match.trigger.substring(0, 20),
                volume: match.volume ?? 1.0 // デフォルト1.0
            };
        } else {
            console.warn(`[EasterEgg] 音声ファイルが見つかりません: ${audioPath}`);
        }
    }

    return null;
}

/**
 * イースターエッグ音声のAudioResourceを生成
 * @param {string} audioPath - 音声ファイルのパス
 * @returns {AudioResource} Discord.js用のAudioResource
 */
function createEasterEggResource(audioPath) {
    return createAudioResource(audioPath, {
        inputType: StreamType.Arbitrary,
        inlineVolume: true
    });
}

/**
 * イースターエッグの一覧を取得
 */
function listEasterEggs() {
    const config = loadConfig();
    return config.entries?.map(e => ({
        trigger: e.trigger,
        description: e.description,
        audioFile: e.audioFile
    })) || [];
}

module.exports = {
    findMatch,
    createEasterEggResource,
    isUserOptedOut,
    addOptOut,
    removeOptOut,
    listEasterEggs,
    normalizeText
};
