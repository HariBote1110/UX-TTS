const fs = require('fs');
const path = require('path');
let Database = null;
try {
    Database = require('better-sqlite3');
} catch (error) {
    Database = null;
}

const sanitise = (value) => String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 64);

const recoverySuffix = sanitise(process.env.BOT_INSTANCE_ID || process.env.CLIENT_ID || 'default');
const RECOVERY_DB_FILE = path.join(__dirname, `../data/recovery_state_${recoverySuffix}.sqlite3`);
const LEGACY_RECOVERY_FILE = path.join(__dirname, `../data/recovery_state_${recoverySuffix}.json`);

// データフォルダがない場合は作成
const dataDir = path.dirname(RECOVERY_DB_FILE);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

class RecoveryManager {
    constructor() {
        this.useFileFallback = false;
        this.data = {};
        this.db = null;

        if (!Database) {
            this._enableJsonFallback('better-sqlite3 not installed');
            return;
        }

        try {
            this.db = new Database(RECOVERY_DB_FILE);
            this.db.pragma('journal_mode = WAL');
            this.db.pragma('synchronous = NORMAL');
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS recovery_connections (
                    guild_id TEXT PRIMARY KEY,
                    voice_channel_id TEXT NOT NULL,
                    text_channel_id TEXT,
                    updated_at INTEGER NOT NULL
                )
            `);

            this.upsertStmt = this.db.prepare(`
                INSERT INTO recovery_connections (guild_id, voice_channel_id, text_channel_id, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(guild_id) DO UPDATE SET
                    voice_channel_id = excluded.voice_channel_id,
                    text_channel_id = excluded.text_channel_id,
                    updated_at = excluded.updated_at
            `);
            this.deleteStmt = this.db.prepare(`
                DELETE FROM recovery_connections
                WHERE guild_id = ?
            `);
            this.selectAllStmt = this.db.prepare(`
                SELECT guild_id, voice_channel_id, text_channel_id, updated_at
                FROM recovery_connections
            `);

            this._migrateLegacyFileIfNeeded();
        } catch (e) {
            console.error('[RecoveryManager] Failed to initialise recovery store:', e.message);
            this._enableJsonFallback(e.message);
        }
    }

    _enableJsonFallback(reason = '') {
        this.useFileFallback = true;
        this.db = null;
        this.data = {};
        if (reason) {
            console.warn(`[RecoveryManager] SQLite unavailable (${reason}). JSON fallback is enabled.`);
        }
        this._loadFromJsonFile();
    }

    _loadFromJsonFile() {
        try {
            if (!fs.existsSync(LEGACY_RECOVERY_FILE)) return;
            const raw = fs.readFileSync(LEGACY_RECOVERY_FILE, 'utf8');
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                this.data = parsed;
            }
        } catch (e) {
            console.error('[RecoveryManager] Failed to load JSON fallback state:', e.message);
            this.data = {};
        }
    }

    _saveToJsonFile() {
        try {
            fs.writeFileSync(LEGACY_RECOVERY_FILE, JSON.stringify(this.data, null, 2));
        } catch (e) {
            console.error('[RecoveryManager] Failed to save JSON fallback state:', e.message);
        }
    }

    _migrateLegacyFileIfNeeded() {
        if (!this.db) return;
        if (!fs.existsSync(LEGACY_RECOVERY_FILE)) return;

        try {
            const raw = fs.readFileSync(LEGACY_RECOVERY_FILE, 'utf8');
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') {
                fs.renameSync(LEGACY_RECOVERY_FILE, `${LEGACY_RECOVERY_FILE}.invalid`);
                return;
            }

            const entries = Object.entries(parsed).filter(([guildId, value]) => {
                return Boolean(guildId) && value && typeof value === 'object' && value.voiceChannelId;
            });
            if (entries.length === 0) {
                fs.renameSync(LEGACY_RECOVERY_FILE, `${LEGACY_RECOVERY_FILE}.migrated`);
                return;
            }

            const insertMany = this.db.transaction((rows) => {
                for (const [guildId, value] of rows) {
                    const timestamp = Number.isInteger(value.timestamp) ? value.timestamp : Date.now();
                    this.upsertStmt.run(
                        String(guildId),
                        String(value.voiceChannelId),
                        value.textChannelId ? String(value.textChannelId) : null,
                        timestamp
                    );
                }
            });
            insertMany(entries);

            fs.renameSync(LEGACY_RECOVERY_FILE, `${LEGACY_RECOVERY_FILE}.migrated`);
            console.log(`[RecoveryManager] Legacy recovery state migrated (${entries.length} entries).`);
        } catch (e) {
            console.error('[RecoveryManager] Failed to migrate legacy recovery state:', e.message);
        }
    }

    /**
     * 接続状態を記録・更新する
     * @param {string} guildId 
     * @param {string} voiceChannelId 
     * @param {string} textChannelId 
     */
    setConnection(guildId, voiceChannelId, textChannelId) {
        if (!guildId || !voiceChannelId) return;

        if (this.useFileFallback) {
            this.data[guildId] = {
                voiceChannelId,
                textChannelId,
                timestamp: Date.now()
            };
            this._saveToJsonFile();
            return;
        }

        if (!this.db) return;
        try {
            this.upsertStmt.run(
                String(guildId),
                String(voiceChannelId),
                textChannelId ? String(textChannelId) : null,
                Date.now()
            );
        } catch (e) {
            console.error('[RecoveryManager] Failed to upsert recovery state:', e.message);
        }
    }

    /**
     * 接続状態を削除する (手動退出やキック時)
     * @param {string} guildId 
     */
    removeConnection(guildId) {
        if (!guildId) return;

        if (this.useFileFallback) {
            if (this.data[guildId]) {
                delete this.data[guildId];
                this._saveToJsonFile();
            }
            return;
        }

        if (!this.db) return;

        try {
            this.deleteStmt.run(String(guildId));
        } catch (e) {
            console.error('[RecoveryManager] Failed to delete recovery state:', e.message);
        }
    }

    /**
     * 全データの取得
     */
    getAllConnections() {
        if (this.useFileFallback) return this.data;
        if (!this.db) return {};

        try {
            const rows = this.selectAllStmt.all();
            const data = {};

            for (const row of rows) {
                data[row.guild_id] = {
                    voiceChannelId: row.voice_channel_id,
                    textChannelId: row.text_channel_id,
                    timestamp: row.updated_at
                };
            }

            return data;
        } catch (e) {
            console.error('[RecoveryManager] Failed to fetch recovery state:', e.message);
            return {};
        }
    }
}

module.exports = new RecoveryManager();
