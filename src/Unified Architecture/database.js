const path = require('path');
const fs = require('fs');
const BetterSqlite3 = require('better-sqlite3');

// データベースのディレクトリパス ("database/")
const dbDir = path.join(__dirname, 'database');

if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
    console.log('database/ ディレクトリを作成しました。');
}

const db = new BetterSqlite3(path.join(dbDir, 'settings.sqlite3'));
const usageDB = new BetterSqlite3(path.join(dbDir, 'usage.sqlite3'));
const cacheDB = new BetterSqlite3(path.join(dbDir, 'cache.sqlite3'));
const licenseDB = new BetterSqlite3(path.join(dbDir, 'licenses.sqlite3'));
const autovcDB = new BetterSqlite3(path.join(dbDir, 'autovc.sqlite3'));

console.log('キャッシュDBに接続しました。');
console.log('設定DBに接続しました。');
console.log('利用状況DBに接続しました。');
console.log('ライセンスDBに接続しました。');
console.log('AutoVC DBに接続しました。');

// --- 共通: 現在月取得 ---
function getCurrentMonth() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// ============================================================================
// 1. 利用状況 (Usage) データベース
// ============================================================================
try {
    const tableExists = usageDB.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='guilds_usage'").get();
    if (tableExists) {
        const tableInfo = usageDB.prepare("PRAGMA table_info(guilds_usage)").all();
        const countCol = tableInfo.find(c => c.name === 'count');
        if (countCol && countCol.type === 'INTEGER') {
            console.log('★ DB更新: guilds_usage をリセットします (型変更)');
            usageDB.prepare("DROP TABLE guilds_usage").run();
        }
    }
} catch (e) {}

usageDB.exec(`
    CREATE TABLE IF NOT EXISTS guilds_usage (
        guild_id TEXT PRIMARY KEY,
        count REAL DEFAULT 0,
        last_reset_month TEXT
    )
`);

const stmtGetGuildUsage = usageDB.prepare('SELECT * FROM guilds_usage WHERE guild_id = ?');
const stmtInsertGuildUsage = usageDB.prepare('INSERT INTO guilds_usage (guild_id, count, last_reset_month) VALUES (?, ?, ?)');
const stmtUpdateGuildUsageCount = usageDB.prepare('UPDATE guilds_usage SET count = ? WHERE guild_id = ?');
const stmtResetGuildUsage = usageDB.prepare('UPDATE guilds_usage SET count = 0, last_reset_month = ? WHERE guild_id = ?');
const stmtGetAllGuildUsage = usageDB.prepare('SELECT * FROM guilds_usage');

// --- ライセンス関連 (License DB) ---
licenseDB.exec(`
    CREATE TABLE IF NOT EXISTS licenses (
        key TEXT PRIMARY KEY,
        max_activations INTEGER DEFAULT 5,
        current_activations INTEGER DEFAULT 0,
        status TEXT DEFAULT 'active',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
`);
licenseDB.exec(`
    CREATE TABLE IF NOT EXISTS activations (
        activation_id INTEGER PRIMARY KEY AUTOINCREMENT,
        license_key TEXT NOT NULL,
        guild_id TEXT NOT NULL UNIQUE,
        activation_date TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (license_key) REFERENCES licenses(key)
    )
`);

const stmtGetLicenseInfo = licenseDB.prepare('SELECT * FROM licenses WHERE key = ?');
const stmtInsertLicense = licenseDB.prepare('INSERT INTO licenses (key, max_activations, status) VALUES (?, ?, ?)');
const stmtIncrementActivations = licenseDB.prepare('UPDATE licenses SET current_activations = current_activations + 1 WHERE key = ?');
const stmtGetActivationByGuild = licenseDB.prepare('SELECT * FROM activations WHERE guild_id = ?');
const stmtInsertActivation = licenseDB.prepare('INSERT INTO activations (license_key, guild_id) VALUES (?, ?)');
const stmtDeleteActivationByGuild = licenseDB.prepare('DELETE FROM activations WHERE guild_id = ?');

function addLicenseKey(key, maxActivations = 5, status = 'active') {
    try { stmtInsertLicense.run(key, maxActivations, status); return true; } catch (e) { return false; }
}
function getLicenseKeyInfo(key) { return stmtGetLicenseInfo.get(key) || null; }
function getServerActivationInfo(guildId) { return stmtGetActivationByGuild.get(guildId) || null; }

function activateLicense(key, guildId) {
    const licenseInfo = getLicenseKeyInfo(key);
    if (!licenseInfo || licenseInfo.status !== 'active') return { success: false, message: '❌ 無効なライセンスキーです。' };
    if (licenseInfo.current_activations >= licenseInfo.max_activations) return { success: false, message: '❌ アクティベーション上限に達しています。' };
    if (getServerActivationInfo(guildId)) return { success: false, message: '❌ 既にアクティベートされています。' };
    try {
        licenseDB.transaction(() => {
            stmtInsertActivation.run(key, guildId);
            stmtIncrementActivations.run(key);
        })();
        return { success: true, message: '✅ アクティベーション成功！' };
    } catch (e) { return { success: false, message: '❌ データベースエラー発生。' }; }
}

function deactivateLicense(guildId) {
    const existing = getServerActivationInfo(guildId);
    if (!existing) return { success: false, message: 'ℹ️ ライセンスは適用されていません。' };
    try {
        stmtDeleteActivationByGuild.run(guildId);
        return { success: true, message: '✅ ライセンス解除成功。' };
    } catch (e) { return { success: false, message: '❌ エラー発生。' }; }
}

function getGuildUsage(guildId) {
    let usage = stmtGetGuildUsage.get(guildId);
    if (!usage) {
        const currentMonth = getCurrentMonth();
        stmtInsertGuildUsage.run(guildId, 0, currentMonth);
        usage = { guild_id: guildId, count: 0, last_reset_month: currentMonth };
    }
    const vvxCharThreshold = parseInt(process.env.VOICEVOX_CHAR_THRESHOLD, 10) || 0;
    const totalCharLimit = parseInt(process.env.TOTAL_CHAR_LIMIT, 10) || 0;
    const activationInfo = getServerActivationInfo(guildId);
    usage.hasLicense = !!activationInfo;
    if (usage.hasLicense) {
        usage.useOjt = false;
        usage.limitExceeded = false;
    } else {
        usage.useOjt = (vvxCharThreshold > 0 && usage.count >= vvxCharThreshold);
        usage.limitExceeded = (totalCharLimit > 0 && usage.count >= totalCharLimit);
    }
    return usage;
}
function addCharacterUsage(guildId, textLength) {
    const usage = getGuildUsage(guildId);
    if (usage.limitExceeded && !usage.hasLicense) return;
    stmtUpdateGuildUsageCount.run(usage.count + textLength, guildId);
}
function resetGuildUsage(guildId, currentMonth) { stmtResetGuildUsage.run(currentMonth, guildId); }
function getAllGuildUsage() { return stmtGetAllGuildUsage.all(); }


// ============================================================================
// 2. 設定 (Settings) データベース
// ============================================================================
db.exec(`
    CREATE TABLE IF NOT EXISTS user_settings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        speaker_id INTEGER,
        speed REAL,
        pitch REAL,
        UNIQUE(guild_id, user_id)
    )
`);

try {
    const columns = db.prepare(`PRAGMA table_info(user_settings)`).all();
    const columnNames = columns.map(c => c.name);
    if (!columnNames.includes('auto_join')) {
        db.prepare('ALTER TABLE user_settings ADD COLUMN auto_join INTEGER DEFAULT 0').run();
    }
    if (!columnNames.includes('active_speech')) {
        db.prepare('ALTER TABLE user_settings ADD COLUMN active_speech INTEGER DEFAULT 0').run();
    }
    if (!columnNames.includes('speaker_type')) {
        db.prepare("ALTER TABLE user_settings ADD COLUMN speaker_type TEXT DEFAULT 'voicevox'").run();
    }
} catch (e) { console.error('マイグレーションエラー (user_settings):', e.message); }

db.exec(`
    CREATE TABLE IF NOT EXISTS guild_settings (
        guild_id TEXT PRIMARY KEY,
        auto_join_enabled INTEGER DEFAULT 0
    )
`);

try {
    const columns = db.prepare(`PRAGMA table_info(guild_settings)`).all();
    const columnNames = columns.map(c => c.name);
    if (!columnNames.includes('read_join')) {
        db.prepare('ALTER TABLE guild_settings ADD COLUMN read_join INTEGER DEFAULT 0').run(); 
    }
    if (!columnNames.includes('read_leave')) {
        db.prepare('ALTER TABLE guild_settings ADD COLUMN read_leave INTEGER DEFAULT 0').run(); 
    }
    if (!columnNames.includes('active_speech')) {
        db.prepare('ALTER TABLE guild_settings ADD COLUMN active_speech INTEGER DEFAULT 0').run();
    }
} catch (e) { console.error('マイグレーションエラー (guild_settings):', e.message); }


db.exec(`
    CREATE TABLE IF NOT EXISTS dictionaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        word TEXT NOT NULL,
        read_as TEXT NOT NULL,
        UNIQUE(guild_id, word)
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS autojoin_ignore_channels (
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        PRIMARY KEY(guild_id, channel_id)
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS autojoin_allow_channels (
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        PRIMARY KEY(guild_id, channel_id)
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS autojoin_channel_pairs (
        guild_id TEXT NOT NULL,
        voice_channel_id TEXT NOT NULL,
        text_channel_id TEXT NOT NULL,
        PRIMARY KEY(guild_id, voice_channel_id)
    )
`);

db.exec(`
    CREATE TABLE IF NOT EXISTS voice_presets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        speaker_id INTEGER,
        speaker_type TEXT,
        speed REAL,
        pitch REAL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
`);

// -- Statements --
const stmtGetUserSettings = db.prepare('SELECT * FROM user_settings WHERE guild_id = ? AND user_id = ?');
const stmtInsertUser = db.prepare('INSERT INTO user_settings (guild_id, user_id) VALUES (?, ?)');
const stmtUpdateSpeaker = db.prepare('UPDATE user_settings SET speaker_id = ?, speaker_type = ? WHERE guild_id = ? AND user_id = ?');
const stmtUpdateSpeed = db.prepare('UPDATE user_settings SET speed = ? WHERE guild_id = ? AND user_id = ?');
const stmtUpdatePitch = db.prepare('UPDATE user_settings SET pitch = ? WHERE guild_id = ? AND user_id = ?');
const stmtResetSettings = db.prepare("UPDATE user_settings SET speaker_id = NULL, speed = NULL, pitch = NULL, speaker_type = 'voicevox' WHERE guild_id = ? AND user_id = ?");
const stmtUpdateUserAutoJoin = db.prepare('UPDATE user_settings SET auto_join = ? WHERE guild_id = ? AND user_id = ?');
const stmtUpdateActiveSpeech = db.prepare('UPDATE user_settings SET active_speech = ? WHERE guild_id = ? AND user_id = ?');

const stmtGetGuildSettings = db.prepare('SELECT * FROM guild_settings WHERE guild_id = ?');
const stmtUpsertGuildSettings = db.prepare(`
    INSERT INTO guild_settings (guild_id, auto_join_enabled) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET auto_join_enabled = excluded.auto_join_enabled
`);
const stmtUpdateReadJoin = db.prepare(`
    INSERT INTO guild_settings (guild_id, read_join) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET read_join = excluded.read_join
`);
const stmtUpdateReadLeave = db.prepare(`
    INSERT INTO guild_settings (guild_id, read_leave) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET read_leave = excluded.read_leave
`);
const stmtUpdateGuildActiveSpeech = db.prepare(`
    INSERT INTO guild_settings (guild_id, active_speech) VALUES (?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET active_speech = excluded.active_speech
`);

const stmtUpsertDict = db.prepare(`INSERT INTO dictionaries (guild_id, word, read_as) VALUES (?, ?, ?) ON CONFLICT(guild_id, word) DO UPDATE SET read_as = excluded.read_as`);
const stmtDeleteDict = db.prepare('DELETE FROM dictionaries WHERE guild_id = ? AND word = ?');
const stmtGetDictList = db.prepare('SELECT word, read_as FROM dictionaries WHERE guild_id = ? ORDER BY length(word) DESC');
const stmtDeleteAllDict = db.prepare('DELETE FROM dictionaries WHERE guild_id = ?');

const stmtInsertIgnoreCh = db.prepare('INSERT OR IGNORE INTO autojoin_ignore_channels (guild_id, channel_id) VALUES (?, ?)');
const stmtDeleteIgnoreCh = db.prepare('DELETE FROM autojoin_ignore_channels WHERE guild_id = ? AND channel_id = ?');
const stmtGetIgnoreChs = db.prepare('SELECT channel_id FROM autojoin_ignore_channels WHERE guild_id = ?');

const stmtInsertAllowCh = db.prepare('INSERT OR IGNORE INTO autojoin_allow_channels (guild_id, channel_id) VALUES (?, ?)');
const stmtDeleteAllowCh = db.prepare('DELETE FROM autojoin_allow_channels WHERE guild_id = ? AND channel_id = ?');
const stmtGetAllowChs = db.prepare('SELECT channel_id FROM autojoin_allow_channels WHERE guild_id = ?');

const stmtUpsertChannelPair = db.prepare(`
    INSERT INTO autojoin_channel_pairs (guild_id, voice_channel_id, text_channel_id) VALUES (?, ?, ?)
    ON CONFLICT(guild_id, voice_channel_id) DO UPDATE SET text_channel_id = excluded.text_channel_id
`);
const stmtDeleteChannelPair = db.prepare('DELETE FROM autojoin_channel_pairs WHERE guild_id = ? AND voice_channel_id = ?');
const stmtGetChannelPair = db.prepare('SELECT * FROM autojoin_channel_pairs WHERE guild_id = ? AND voice_channel_id = ?');
const stmtGetAllChannelPairs = db.prepare('SELECT * FROM autojoin_channel_pairs WHERE guild_id = ?');

const stmtAddPreset = db.prepare('INSERT INTO voice_presets (user_id, name, speaker_id, speaker_type, speed, pitch) VALUES (?, ?, ?, ?, ?, ?)');
const stmtGetPresets = db.prepare('SELECT * FROM voice_presets WHERE user_id = ? ORDER BY created_at DESC');
const stmtGetPresetById = db.prepare('SELECT * FROM voice_presets WHERE id = ?');
const stmtDeletePreset = db.prepare('DELETE FROM voice_presets WHERE id = ? AND user_id = ?');
const stmtUpdatePreset = db.prepare('UPDATE voice_presets SET name = ?, speaker_id = ?, speaker_type = ?, speed = ?, pitch = ? WHERE id = ? AND user_id = ?');

// --- User Settings Functions ---
function getUserSettings(guildId, userId) {
    let settings = stmtGetUserSettings.get(guildId, userId);
    if (!settings) {
        stmtInsertUser.run(guildId, userId);
        settings = { 
            guild_id: guildId, user_id: userId, 
            speaker_id: null, speed: null, pitch: null, 
            auto_join: 0, active_speech: 0, speaker_type: 'voicevox' 
        };
    }
    return settings;
}
function setUserSpeakerId(guildId, userId, speakerId, type = 'voicevox') { getUserSettings(guildId, userId); stmtUpdateSpeaker.run(speakerId, type, guildId, userId); }
function setUserSpeed(guildId, userId, speed) { getUserSettings(guildId, userId); stmtUpdateSpeed.run(speed, guildId, userId); }
function setUserPitch(guildId, userId, pitch) { getUserSettings(guildId, userId); stmtUpdatePitch.run(pitch, guildId, userId); }
function resetUserSettings(guildId, userId) { getUserSettings(guildId, userId); stmtResetSettings.run(guildId, userId); }
function setUserAutoJoin(guildId, userId, enable) { getUserSettings(guildId, userId); stmtUpdateUserAutoJoin.run(enable ? 1 : 0, guildId, userId); }
function setUserActiveSpeech(guildId, userId, enable) { getUserSettings(guildId, userId); stmtUpdateActiveSpeech.run(enable ? 1 : 0, guildId, userId); }

// --- Guild Settings Functions ---
function getGuildSettings(guildId) {
    let settings = stmtGetGuildSettings.get(guildId);
    if (!settings) { 
        return { guild_id: guildId, auto_join_enabled: 0, read_join: 0, read_leave: 0, active_speech: 0 }; 
    }
    if (settings.read_join === null) settings.read_join = 0;
    if (settings.read_leave === null) settings.read_leave = 0;
    if (settings.active_speech === undefined || settings.active_speech === null) settings.active_speech = 0;
    return settings;
}
function setGuildAutoJoin(guildId, enable) { stmtUpsertGuildSettings.run(guildId, enable ? 1 : 0); }
function setGuildReadJoin(guildId, enable) { stmtUpdateReadJoin.run(guildId, enable ? 1 : 0); }
function setGuildReadLeave(guildId, enable) { stmtUpdateReadLeave.run(guildId, enable ? 1 : 0); }
function setGuildActiveSpeech(guildId, enable) { stmtUpdateGuildActiveSpeech.run(guildId, enable ? 1 : 0); }

// --- Dictionary & Channel Functions ---
function addDictionaryEntry(guildId, word, readAs) { try { stmtUpsertDict.run(guildId, word, readAs); return true; } catch (e) { return false; } }
function removeDictionaryEntry(guildId, word) { const res = stmtDeleteDict.run(guildId, word); return res.changes > 0; }
function getDictionaryEntries(guildId) { return stmtGetDictList.all(guildId); }

function importDictionary(guildId, entries) {
    const insert = db.transaction((items) => {
        let count = 0;
        for (const item of items) {
            try {
                if(item.word && item.read) {
                    stmtUpsertDict.run(guildId, item.word, item.read);
                    count++;
                }
            } catch (e) {
                console.error(`辞書インポートエラー (${item.word}):`, e.message);
            }
        }
        return count;
    });
    return insert(entries);
}
function clearDictionary(guildId) { try { const res = stmtDeleteAllDict.run(guildId); return res.changes; } catch(e) { return 0; } }

function addIgnoreChannel(guildId, channelId) { try { stmtInsertIgnoreCh.run(guildId, channelId); return true; } catch (e) { return false; } }
function removeIgnoreChannel(guildId, channelId) { const res = stmtDeleteIgnoreCh.run(guildId, channelId); return res.changes > 0; }
function getIgnoreChannels(guildId) { const rows = stmtGetIgnoreChs.all(guildId); return rows.map(r => r.channel_id); }

function addAllowChannel(guildId, channelId) { try { stmtInsertAllowCh.run(guildId, channelId); return true; } catch (e) { return false; } }
function removeAllowChannel(guildId, channelId) { const res = stmtDeleteAllowCh.run(guildId, channelId); return res.changes > 0; }
function getAllowChannels(guildId) { const rows = stmtGetAllowChs.all(guildId); return rows.map(r => r.channel_id); }

function addChannelPair(guildId, voiceId, textId) { try { stmtUpsertChannelPair.run(guildId, voiceId, textId); return true; } catch (e) { return false; } }
function removeChannelPair(guildId, voiceId) { const res = stmtDeleteChannelPair.run(guildId, voiceId); return res.changes > 0; }
function getChannelPair(guildId, voiceId) { return stmtGetChannelPair.get(guildId, voiceId); }
function getAllChannelPairs(guildId) { return stmtGetAllChannelPairs.all(guildId); }

function addVoicePreset(userId, name, settings) { try { stmtAddPreset.run(userId, name, settings.speaker_id, settings.speaker_type, settings.speed, settings.pitch); return true; } catch (e) { return false; } }
function updateVoicePreset(userId, presetId, name, settings) { try { stmtUpdatePreset.run(name, settings.speaker_id, settings.speaker_type, settings.speed, settings.pitch, presetId, userId); return true; } catch (e) { return false; } }
function getVoicePresets(userId) { return stmtGetPresets.all(userId); }
function getVoicePreset(presetId) { return stmtGetPresetById.get(presetId); }
function deleteVoicePreset(presetId, userId) { stmtDeletePreset.run(presetId, userId); }


// ============================================================================
// 3. 音声キャッシュ (Cache) データベース
// ============================================================================
const stmtGetCache = cacheDB.prepare('SELECT file_path FROM audio_cache WHERE text_hash = ? AND speaker_id = ? AND speed = ? AND pitch = ?');
const stmtInsertCache = cacheDB.prepare('INSERT INTO audio_cache (text_hash, speaker_id, speed, pitch, file_path, last_accessed, file_size) VALUES (?, ?, ?, ?, ?, ?, ?)');
const stmtUpdateCacheAccess = cacheDB.prepare('UPDATE audio_cache SET last_accessed = ? WHERE file_path = ?');
const stmtGetCacheAll = cacheDB.prepare('SELECT file_path, file_size FROM audio_cache ORDER BY last_accessed DESC');
const stmtDeleteCache = cacheDB.prepare('DELETE FROM audio_cache WHERE file_path = ?');

function getCache(hash, speakerId, speed, pitch) {
    const row = stmtGetCache.get(hash, speakerId, speed, pitch);
    if (row) { stmtUpdateCacheAccess.run(Date.now(), row.file_path); return row.file_path; }
    return null;
}
function insertCache(hash, speakerId, speed, pitch, filePath, fileSize) { stmtInsertCache.run(hash, speakerId, speed, pitch, filePath, Date.now(), fileSize); }
function getAllCacheEntries() { return stmtGetCacheAll.all(); }
function deleteCacheEntry(filePath) { stmtDeleteCache.run(filePath); }


// ============================================================================
// 4. AutoVC (自動チャンネル作成) データベース
// ============================================================================
try {
    const info = autovcDB.prepare("PRAGMA table_info(active_channels)").all();
    if (info.length > 0 && !info.some(c => c.name === 'archive_channel_id')) {
        console.log('★ DB更新: active_channels テーブルを再作成します...');
        autovcDB.prepare("DROP TABLE active_channels").run();
    }
} catch (e) {}

autovcDB.exec(`
    CREATE TABLE IF NOT EXISTS generators (
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        category_id TEXT,
        text_channel_id TEXT,
        naming_pattern TEXT DEFAULT '{user}の部屋',
        PRIMARY KEY(guild_id, channel_id)
    )
`);

autovcDB.exec(`
    CREATE TABLE IF NOT EXISTS active_channels (
        voice_channel_id TEXT PRIMARY KEY,
        archive_channel_id TEXT,
        guild_id TEXT NOT NULL,
        owner_id TEXT NOT NULL,
        created_at INTEGER
    )
`);

const stmtAddGenerator = autovcDB.prepare('INSERT OR REPLACE INTO generators (guild_id, channel_id, category_id, text_channel_id, naming_pattern) VALUES (?, ?, ?, ?, ?)');
const stmtGetGenerator = autovcDB.prepare('SELECT * FROM generators WHERE guild_id = ? AND channel_id = ?');
const stmtRemoveGenerator = autovcDB.prepare('DELETE FROM generators WHERE guild_id = ? AND channel_id = ?');
const stmtGetGeneratorsByGuild = autovcDB.prepare('SELECT * FROM generators WHERE guild_id = ?'); // ★ 追加

const stmtAddActiveChannel = autovcDB.prepare('INSERT INTO active_channels (voice_channel_id, archive_channel_id, guild_id, owner_id, created_at) VALUES (?, ?, ?, ?, ?)');
const stmtGetActiveChannel = autovcDB.prepare('SELECT * FROM active_channels WHERE voice_channel_id = ?');
const stmtRemoveActiveChannel = autovcDB.prepare('DELETE FROM active_channels WHERE voice_channel_id = ?');
const stmtGetActiveChannelByOwner = autovcDB.prepare('SELECT * FROM active_channels WHERE owner_id = ?');

function addAutoVCGenerator(guildId, channelId, categoryId, textChannelId, namingPattern) {
    stmtAddGenerator.run(guildId, channelId, categoryId, textChannelId, namingPattern);
}
function getAutoVCGenerator(guildId, channelId) { return stmtGetGenerator.get(guildId, channelId); }
function getAutoVCGenerators(guildId) { return stmtGetGeneratorsByGuild.all(guildId); } // ★ 追加
function removeAutoVCGenerator(guildId, channelId) { stmtRemoveGenerator.run(guildId, channelId); }

function addActiveChannel(voiceId, archiveChannelId, guildId, ownerId) {
    stmtAddActiveChannel.run(voiceId, archiveChannelId, guildId, ownerId, Date.now());
}
function getActiveChannel(voiceId) { return stmtGetActiveChannel.get(voiceId); }
function removeActiveChannel(voiceId) { stmtRemoveActiveChannel.run(voiceId); }
function getActiveChannelByOwner(ownerId) { return stmtGetActiveChannelByOwner.get(ownerId); }


module.exports = {
    getCurrentMonth,
    getGuildUsage, addCharacterUsage, resetGuildUsage, getAllGuildUsage,
    addLicenseKey, getLicenseKeyInfo, getServerActivationInfo, activateLicense, deactivateLicense,
    getUserSettings, setUserSpeakerId, setUserSpeed, setUserPitch, resetUserSettings, setUserAutoJoin,
    setUserActiveSpeech,
    getGuildSettings, setGuildAutoJoin, setGuildReadJoin, setGuildReadLeave, setGuildActiveSpeech, 
    addDictionaryEntry, removeDictionaryEntry, getDictionaryEntries,
    importDictionary, clearDictionary,
    
    addIgnoreChannel, removeIgnoreChannel, getIgnoreChannels,
    addAllowChannel, removeAllowChannel, getAllowChannels,

    addChannelPair, removeChannelPair, getChannelPair, getAllChannelPairs,
    addVoicePreset, getVoicePresets, getVoicePreset, deleteVoicePreset, updateVoicePreset,

    getCache, insertCache, getAllCacheEntries, deleteCacheEntry,

    addAutoVCGenerator, getAutoVCGenerator, getAutoVCGenerators, removeAutoVCGenerator, // ★ Export追加
    addActiveChannel, getActiveChannel, removeActiveChannel, getActiveChannelByOwner
};