const axios = require('axios');
const { parseLayerDBaseUrls } = require('./lib/parseLayerDBaseUrls');

class LayerDClient {
    constructor(options = {}) {
        const rawUrls = options.baseUrl || process.env.LAYER_D_URL || '';
        this.urls = parseLayerDBaseUrls(rawUrls);
        this.apiKey = options.apiKey || process.env.DATABASE_API_KEY;
        if (!this.apiKey) {
            console.error('[Layer-E] DATABASE_API_KEY が設定されていません。');
            process.exit(1);
        }
        this.timeoutMs = Number.parseInt(process.env.LAYER_E_LAYER_D_TIMEOUT_MS || '5000', 10);
        this.activeIndex = 0;
    }

    get activeUrl() {
        return this.urls[this.activeIndex];
    }

    // guildId はスコープなし（Layer-E は namespacing を使わない）
    // Layer-D が直接 guildId を受け取るのでそのまま渡す

    async request(method, path, data = {}, retryCount = 0) {
        try {
            const response = await axios({
                method,
                url: `${this.activeUrl}${path}`,
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                },
                data,
                timeout: this.timeoutMs,
            });
            return response.data;
        } catch (error) {
            if (retryCount < this.urls.length - 1) {
                this.activeIndex = (this.activeIndex + 1) % this.urls.length;
                return this.request(method, path, data, retryCount + 1);
            }
            throw error;
        }
    }

    // ─── Usage ───────────────────────────────────────────────────────────────
    // POST /usage/get  { guildId }

    async getGuildUsage(guildId) {
        return this.request('POST', '/usage/get', { guildId });
    }

    // ─── Guild Settings ───────────────────────────────────────────────────────
    // POST /settings/guild/get      { guildId }
    // POST /settings/guild/update-* { guildId, enable }

    async getGuildSettings(_namespace, guildId) {
        try {
            const settings = await this.request('POST', '/settings/guild/get', { guildId });
            return settings || { guild_id: guildId, auto_join_enabled: 0, read_join: 0, read_leave: 0, active_speech: 0 };
        } catch {
            return { guild_id: guildId, auto_join_enabled: 0, read_join: 0, read_leave: 0, active_speech: 0 };
        }
    }

    async updateGuildSettings(_namespace, guildId, values) {
        await Promise.all([
            this.request('POST', '/settings/guild/update-autojoin', { guildId, enable: !!values.auto_join_enabled }),
            this.request('POST', '/settings/guild/update-read-join', { guildId, enable: !!values.read_join }),
            this.request('POST', '/settings/guild/update-read-leave', { guildId, enable: !!values.read_leave }),
            this.request('POST', '/settings/guild/update-speech', { guildId, enable: !!values.active_speech }),
        ]);
    }

    async setGuildAutoJoin(_namespace, guildId, enable) {
        return this.request('POST', '/settings/guild/update-autojoin', { guildId, enable: !!enable });
    }

    // ─── Dictionary ───────────────────────────────────────────────────────────
    // POST /dict/list      { guildId }
    // POST /dict/add       { guildId, word, readAs }
    // POST /dict/remove-id { guildId, id }
    // POST /dict/clear     { guildId }
    // POST /dict/import    { guildId, entries: [{word,read}] }

    async getDictionary(_namespace, guildId) {
        const entries = await this.request('POST', '/dict/list', { guildId });
        if (!Array.isArray(entries)) return [];
        // Layer-D returns { id, guild_id, word, read_as }
        return entries;
    }

    async getDictionaryCount(_namespace, guildId) {
        const entries = await this.getDictionary(null, guildId);
        return entries.length;
    }

    async addDictionaryEntry(_namespace, guildId, word, read) {
        // Layer-D field name is "readAs" (camelCase)
        return this.request('POST', '/dict/add', { guildId, word, readAs: read });
    }

    async deleteDictionaryEntry(_namespace, guildId, entryId) {
        return this.request('POST', '/dict/remove-id', { guildId, id: Number(entryId) });
    }

    async clearDictionary(_namespace, guildId) {
        return this.request('POST', '/dict/clear', { guildId });
    }

    async importDictionary(_namespace, guildId, entries) {
        return this.request('POST', '/dict/import', { guildId, entries });
    }

    // POST /user-dict/list      { userId }
    // POST /user-dict/add       { userId, word, readAs }
    // POST /user-dict/remove-id { userId, id }

    async getUserPersonalDictionary(userId) {
        const entries = await this.request('POST', '/user-dict/list', { userId: String(userId) });
        return Array.isArray(entries) ? entries : [];
    }

    async addUserPersonalDictionaryEntry(userId, word, read) {
        return this.request('POST', '/user-dict/add', { userId: String(userId), word, readAs: read });
    }

    async deleteUserPersonalDictionaryEntry(userId, entryId) {
        return this.request('POST', '/user-dict/remove-id', { userId: String(userId), id: Number(entryId) });
    }

    // ─── Ignore Channels ─────────────────────────────────────────────────────
    // POST /channels/ignore/list   { guildId }  → string[]
    // POST /channels/ignore/add    { guildId, channelId }
    // POST /channels/ignore/remove { guildId, channelId }

    async getIgnoreChannels(_namespace, guildId) {
        const result = await this.request('POST', '/channels/ignore/list', { guildId });
        return Array.isArray(result) ? result : [];
    }

    async getIgnoreChannelsCount(_namespace, guildId) {
        const channels = await this.getIgnoreChannels(null, guildId);
        return channels.length;
    }

    async addIgnoreChannel(_namespace, guildId, channelId) {
        return this.request('POST', '/channels/ignore/add', { guildId, channelId });
    }

    async removeIgnoreChannel(_namespace, guildId, channelId) {
        return this.request('POST', '/channels/ignore/remove', { guildId, channelId });
    }

    // ─── Allow Channels ──────────────────────────────────────────────────────
    // POST /channels/allow/list   { guildId }  → string[]
    // POST /channels/allow/add    { guildId, channelId }
    // POST /channels/allow/remove { guildId, channelId }

    async getAllowChannels(_namespace, guildId) {
        const result = await this.request('POST', '/channels/allow/list', { guildId });
        return Array.isArray(result) ? result : [];
    }

    async getAllowChannelsCount(_namespace, guildId) {
        const channels = await this.getAllowChannels(null, guildId);
        return channels.length;
    }

    async addAllowChannel(_namespace, guildId, channelId) {
        return this.request('POST', '/channels/allow/add', { guildId, channelId });
    }

    async removeAllowChannel(_namespace, guildId, channelId) {
        return this.request('POST', '/channels/allow/remove', { guildId, channelId });
    }

    // ─── Channel Pairs ────────────────────────────────────────────────────────
    // POST /channels/pair/all    { guildId }  → [{guild_id, voice_channel_id, text_channel_id}]
    // POST /channels/pair/add    { guildId, voiceId, textId }
    // POST /channels/pair/remove { guildId, voiceId }

    async getChannelPairs(_namespace, guildId) {
        const result = await this.request('POST', '/channels/pair/all', { guildId });
        return Array.isArray(result) ? result : [];
    }

    async addChannelPair(_namespace, guildId, voiceChannelId, textChannelId) {
        return this.request('POST', '/channels/pair/add', {
            guildId,
            voiceId: voiceChannelId,
            textId: textChannelId,
        });
    }

    async removeChannelPair(_namespace, guildId, voiceChannelId) {
        return this.request('POST', '/channels/pair/remove', { guildId, voiceId: voiceChannelId });
    }

    // ─── AutoVC Generators ───────────────────────────────────────────────────
    // POST /autovc/gen/list   { guildId }  → [{guild_id, channel_id, category_id, text_channel_id, naming_pattern}]
    // POST /autovc/gen/add    { guildId, channelId, categoryId, textChannelId, namingPattern }
    // POST /autovc/gen/remove { guildId, channelId }

    async getAutoVCGenerators(_namespace, guildId) {
        const result = await this.request('POST', '/autovc/gen/list', { guildId });
        return Array.isArray(result) ? result : [];
    }

    async getAutoVCGeneratorsCount(_namespace, guildId) {
        const generators = await this.getAutoVCGenerators(null, guildId);
        return generators.length;
    }

    async addAutoVCGenerator(_namespace, guildId, triggerChannelId, categoryId, archiveChannelId, namingPattern) {
        return this.request('POST', '/autovc/gen/add', {
            guildId,
            channelId: triggerChannelId,
            categoryId: categoryId || '',
            textChannelId: archiveChannelId || '',
            namingPattern: namingPattern || '{user}の部屋',
        });
    }

    async removeAutoVCGenerator(_namespace, guildId, triggerChannelId) {
        return this.request('POST', '/autovc/gen/remove', { guildId, channelId: triggerChannelId });
    }
}

module.exports = LayerDClient;
