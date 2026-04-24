const axios = require('axios');

const DISCORD_API_BASE = 'https://discord.com/api/v10';

// Discord channel type constants
const ChannelType = {
    GUILD_TEXT: 0,
    GUILD_VOICE: 2,
    GUILD_CATEGORY: 4,
    GUILD_STAGE_VOICE: 13,
};

class DiscordRestClient {
    constructor(botToken) {
        this.botToken = botToken;
    }

    async getGuildChannels(guildId) {
        if (!this.botToken) {
            return { voiceChannels: [], textChannels: [], categories: [] };
        }

        try {
            const response = await axios.get(
                `${DISCORD_API_BASE}/guilds/${guildId}/channels`,
                {
                    headers: {
                        Authorization: `Bot ${this.botToken}`,
                        'Content-Type': 'application/json',
                    },
                    timeout: 5000,
                }
            );

            const channels = response.data;

            const voiceChannels = channels
                .filter((c) => c.type === ChannelType.GUILD_VOICE || c.type === ChannelType.GUILD_STAGE_VOICE)
                .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
                .map((c) => ({ id: c.id, name: c.name, type: c.type }));

            const textChannels = channels
                .filter((c) => c.type === ChannelType.GUILD_TEXT)
                .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
                .map((c) => ({ id: c.id, name: c.name, type: c.type }));

            const categories = channels
                .filter((c) => c.type === ChannelType.GUILD_CATEGORY)
                .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
                .map((c) => ({ id: c.id, name: c.name, type: c.type }));

            return { voiceChannels, textChannels, categories };
        } catch (error) {
            console.error(`[DiscordRestClient] Failed to fetch channels for guild ${guildId}:`, error.message);
            return { voiceChannels: [], textChannels: [], categories: [] };
        }
    }

    /**
     * Resolves channel IDs to channel objects using the guild's channel list.
     * Returns a map from ID to { id, name }.
     */
    async buildChannelMap(guildId) {
        if (!this.botToken) return new Map();

        try {
            const response = await axios.get(
                `${DISCORD_API_BASE}/guilds/${guildId}/channels`,
                {
                    headers: { Authorization: `Bot ${this.botToken}` },
                    timeout: 5000,
                }
            );

            const map = new Map();
            for (const ch of response.data) {
                map.set(ch.id, { id: ch.id, name: ch.name, type: ch.type });
            }
            return map;
        } catch (error) {
            console.error(`[DiscordRestClient] buildChannelMap failed for guild ${guildId}:`, error.message);
            return new Map();
        }
    }

    /**
     * Returns a Set of guild IDs that the Bot has joined.
     * Uses GET /users/@me/guilds with the Bot Token.
     * Results are cached for cacheTtlMs milliseconds (default: 5 minutes).
     */
    async getBotGuildIds() {
        if (!this.botToken) return new Set();

        // Simple TTL cache to avoid hammering the Discord API
        const now = Date.now();
        const cacheTtlMs = 5 * 60 * 1000; // 5 minutes
        if (this._botGuildCache && now - this._botGuildCacheAt < cacheTtlMs) {
            return this._botGuildCache;
        }

        try {
            // The endpoint supports up to 200 guilds per request.
            // For bots in more than 200 guilds, pagination would be needed,
            // but typical self-hosted bots are well within this limit.
            const response = await axios.get(
                `${DISCORD_API_BASE}/users/@me/guilds?limit=200`,
                {
                    headers: { Authorization: `Bot ${this.botToken}` },
                    timeout: 5000,
                }
            );

            const ids = new Set(response.data.map((g) => g.id));
            this._botGuildCache = ids;
            this._botGuildCacheAt = now;
            console.log(`[DiscordRestClient] Bot is in ${ids.size} guilds.`);
            return ids;
        } catch (error) {
            console.error('[DiscordRestClient] getBotGuildIds failed:', error.message);
            // On failure, return an empty Set so all guilds are hidden
            // rather than showing guilds where the Bot may not be present.
            return new Set();
        }
    }
}

module.exports = DiscordRestClient;
