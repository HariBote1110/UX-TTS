const axios = require('axios');

// --- Configuration ---
const LAYER_D_URLS = (process.env.LAYER_D_URL || '').split(',').map(u => u.trim());
const API_KEY = process.env.DATABASE_API_KEY;

if (!API_KEY) {
    console.error('CRITICAL ERROR: DATABASE_API_KEY environment variable is missing.');
    process.exit(1);
}

const parseBoolean = (value, defaultValue) => {
    if (value == null || value === '') return defaultValue;
    const normalised = String(value).toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalised)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalised)) return false;
    return defaultValue;
};

const isSharedBotMode = parseBoolean(process.env.BOT_SHARED_MODE, true);
const rawBotNamespace = (process.env.BOT_DB_NAMESPACE || '').trim();
const BOT_DB_NAMESPACE = isSharedBotMode ? '' : rawBotNamespace;
const BOT_DB_NAMESPACE_PREFIX = BOT_DB_NAMESPACE ? `${BOT_DB_NAMESPACE}::` : '';

let activeUrlIndex = 0;
let isHealing = false;

if (isSharedBotMode) {
    if (rawBotNamespace) {
        console.log(`[Layer-D Namespace] Shared mode enabled. BOT_DB_NAMESPACE (${rawBotNamespace}) is ignored.`);
    } else {
        console.log('[Layer-D Namespace] Shared mode enabled. All bot settings are shared.');
    }
} else if (BOT_DB_NAMESPACE) {
    console.log(`[Layer-D Namespace] Bot DB namespace enabled: ${BOT_DB_NAMESPACE}`);
} else {
    console.log('[Layer-D Namespace] Namespace is disabled and BOT_SHARED_MODE is false.');
}

function getActiveClient() {
    return axios.create({
        baseURL: LAYER_D_URLS[activeUrlIndex],
        headers: {
            'Authorization': `Bearer ${API_KEY}`,
            'Content-Type': 'application/json'
        },
        timeout: 5000
    });
}

// Health Check (Self-healing)
async function runHealthCheck() {
    if (activeUrlIndex === 0 || isHealing) return;
    isHealing = true;

    try {
        // Primary (index 0) への接続テスト
        const primaryClient = axios.create({
            baseURL: LAYER_D_URLS[0],
            headers: { 'Authorization': `Bearer ${API_KEY}` },
            timeout: 2000
        });
        await primaryClient.post('/usage/all');
        console.log(`[Layer-D Failover] Primary node (${LAYER_D_URLS[0]}) recovered. Switching back.`);
        activeUrlIndex = 0;
    } catch (e) {
        // Still down
    } finally {
        isHealing = false;
    }
}

// 定期的に回復をチェック
setInterval(runHealthCheck, 60000); // 1分おき

// Helper for error handling with Failover
const request = async (method, url, data = {}, retryCount = 0) => {
    try {
        const client = getActiveClient();
        const response = await client({ method, url, data });
        return response.data;
    } catch (error) {
        const currentUrl = LAYER_D_URLS[activeUrlIndex];
        console.warn(`[Layer-D API Error] ${currentUrl} (${method} ${url}):`, error.message);

        // Failover: 別のURLを試す
        if (retryCount < LAYER_D_URLS.length - 1) {
            activeUrlIndex = (activeUrlIndex + 1) % LAYER_D_URLS.length;
            const nextUrl = LAYER_D_URLS[activeUrlIndex];
            console.log(`[Layer-D Failover] Switching to next node: ${nextUrl} (Priority: ${activeUrlIndex})`);
            return await request(method, url, data, retryCount + 1);
        }

        return null;
    }
};

// --- Common ---
function getCurrentMonth() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function scopeId(value) {
    if (!BOT_DB_NAMESPACE_PREFIX || value == null) return value;
    return `${BOT_DB_NAMESPACE_PREFIX}${value}`;
}

function unscopeId(value) {
    if (!BOT_DB_NAMESPACE_PREFIX || typeof value !== 'string') return value;
    if (!value.startsWith(BOT_DB_NAMESPACE_PREFIX)) return value;
    return value.slice(BOT_DB_NAMESPACE_PREFIX.length);
}

function withRawGuildId(result, key = 'guild_id') {
    if (!result || typeof result !== 'object') return result;
    if (typeof result[key] === 'string') {
        result[key] = unscopeId(result[key]);
    }
    return result;
}

// --- Usage Endpoints ---
async function getGuildUsage(guildId) {
    const usage = await request('POST', '/usage/get', { guildId });
    if (!usage) return { guild_id: guildId, count: 0, last_reset_month: getCurrentMonth() };

    const vvxCharThreshold = parseInt(process.env.VOICEVOX_CHAR_THRESHOLD, 10) || 0;
    const totalCharLimit = parseInt(process.env.TOTAL_CHAR_LIMIT, 10) || 0;
    const activationInfo = await getServerActivationInfo(guildId);

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

async function addCharacterUsage(guildId, textLength) {
    await request('POST', '/usage/add', { guildId, textLength });
}

async function resetGuildUsage(guildId, currentMonth) {
    await request('POST', '/usage/reset', { guildId, currentMonth });
}

async function getAllGuildUsage() {
    const res = await request('POST', '/usage/all');
    return res || [];
}

// --- License Endpoints ---
async function addLicenseKey(key, maxActivations = 5, status = 'active') {
    const res = await request('POST', '/license/add', { key, max: maxActivations, status });
    return !!(res && res.success);
}

async function getLicenseKeyInfo(key) {
    return await request('POST', '/license/info', { key });
}

async function getServerActivationInfo(guildId) {
    return await request('POST', '/license/activation', { guildId });
}

async function activateLicense(key, guildId) {
    const licenseInfo = await getLicenseKeyInfo(key);
    if (!licenseInfo || licenseInfo.status !== 'active') return { success: false, message: '❌ 無効なライセンスキーです。' };
    if (licenseInfo.current_activations >= licenseInfo.max_activations) return { success: false, message: '❌ アクティベーション上限に達しています。' };
    if (await getServerActivationInfo(guildId)) return { success: false, message: '❌ 既にアクティベートされています。' };

    const res = await request('POST', '/license/activate', { key, guildId });
    if (res && res.success) return { success: true, message: '✅ アクティベーション成功！' };
    return { success: false, message: '❌ データベースエラー発生。' };
}

async function deactivateLicense(guildId) {
    const existing = await getServerActivationInfo(guildId);
    if (!existing) return { success: false, message: 'ℹ️ ライセンスは適用されていません。' };
    const res = await request('POST', '/license/deactivate', { guildId });
    if (res && res.success) return { success: true, message: '✅ ライセンス解除成功。' };
    return { success: false, message: '❌ エラー発生。' };
}

// --- User Settings Endpoints ---
async function getUserSettings(guildId, userId) {
    const scopedGuildId = scopeId(guildId);
    const settings = await request('POST', '/settings/user/get', { guildId: scopedGuildId, userId });
    if (!settings) return {
        guild_id: guildId, user_id: userId,
        speaker_id: null, speed: null, pitch: null,
        auto_join: 0, active_speech: 0, speaker_type: 'voicevox',
        guild_default_speaker_id: null, guild_default_speaker_type: 'voicevox'
    };
    const result = withRawGuildId(settings);
    if (!Object.prototype.hasOwnProperty.call(result, 'guild_default_speaker_id')) {
        result.guild_default_speaker_id = null;
    }
    if (!result.guild_default_speaker_type) {
        result.guild_default_speaker_type = 'voicevox';
    }
    return result;
}

async function setUserSpeakerId(guildId, userId, speakerId, type = 'voicevox') {
    await request('POST', '/settings/user/update-speaker', { guildId: scopeId(guildId), userId, speakerId, type });
}

async function setUserSpeed(guildId, userId, speed) {
    await request('POST', '/settings/user/update-speed', { guildId: scopeId(guildId), userId, value: speed });
}

async function setUserPitch(guildId, userId, pitch) {
    await request('POST', '/settings/user/update-pitch', { guildId: scopeId(guildId), userId, value: pitch });
}

async function resetUserSettings(guildId, userId) {
    await request('POST', '/settings/user/reset', { guildId: scopeId(guildId), userId });
}

async function setUserAutoJoin(guildId, userId, enable) {
    await request('POST', '/settings/user/update-autojoin', { guildId: scopeId(guildId), userId, enable });
}

async function setUserActiveSpeech(guildId, userId, enable) {
    await request('POST', '/settings/user/update-speech', { guildId: scopeId(guildId), userId, enable });
}

// --- Guild Settings Endpoints ---
async function getGuildSettings(guildId) {
    const settings = await request('POST', '/settings/guild/get', { guildId: scopeId(guildId) });
    if (!settings) return {
        guild_id: guildId,
        auto_join_enabled: 0,
        read_join: 0,
        read_leave: 0,
        active_speech: 0,
        default_speaker_id: null,
        default_speaker_type: 'voicevox'
    };
    const result = withRawGuildId(settings);
    if (!Object.prototype.hasOwnProperty.call(result, 'default_speaker_id')) {
        result.default_speaker_id = null;
    }
    if (!result.default_speaker_type) {
        result.default_speaker_type = 'voicevox';
    }
    return result;
}

async function setGuildAutoJoin(guildId, enable) {
    await request('POST', '/settings/guild/update-autojoin', { guildId: scopeId(guildId), enable });
}

async function setGuildReadJoin(guildId, enable) {
    await request('POST', '/settings/guild/update-read-join', { guildId: scopeId(guildId), enable });
}

async function setGuildReadLeave(guildId, enable) {
    await request('POST', '/settings/guild/update-read-leave', { guildId: scopeId(guildId), enable });
}

async function setGuildActiveSpeech(guildId, enable) {
    await request('POST', '/settings/guild/update-speech', { guildId: scopeId(guildId), enable });
}

async function setGuildDefaultSpeaker(guildId, speakerId, type = 'voicevox') {
    await request('POST', '/settings/guild/update-default-speaker', { guildId: scopeId(guildId), speakerId, type });
}

async function resetGuildDefaultSpeaker(guildId) {
    await request('POST', '/settings/guild/reset-default-speaker', { guildId: scopeId(guildId) });
}

// --- Dictionary Endpoints ---
async function addDictionaryEntry(guildId, word, readAs) {
    const res = await request('POST', '/dict/add', { guildId: scopeId(guildId), word, readAs });
    return !!(res && res.success);
}

async function removeDictionaryEntry(guildId, word) {
    const res = await request('POST', '/dict/remove', { guildId: scopeId(guildId), word });
    return !!(res && res.success);
}

async function removeDictionaryEntryById(guildId, id) {
    const res = await request('POST', '/dict/remove-id', { guildId: scopeId(guildId), id });
    return !!(res && res.success);
}

async function getDictionaryEntries(guildId) {
    const res = await request('POST', '/dict/list', { guildId: scopeId(guildId) });
    return res || [];
}

async function importDictionary(guildId, entries) {
    const res = await request('POST', '/dict/import', { guildId: scopeId(guildId), entries });
    return res ? res.count : 0;
}

async function clearDictionary(guildId) {
    const res = await request('POST', '/dict/clear', { guildId: scopeId(guildId) });
    return res ? res.count : 0;
}

// --- User personal dictionary (per Discord user, max 10 entries, replicated via settings DB) ---
async function addUserPersonalDictionaryEntry(userId, word, readAs) {
    const res = await request('POST', '/user-dict/add', { userId: scopeId(userId), word, readAs });
    if (!res || typeof res !== 'object') return { success: false, error: 'network' };
    return res;
}

async function removeUserPersonalDictionaryEntryById(userId, id) {
    const res = await request('POST', '/user-dict/remove-id', { userId: scopeId(userId), id: Number(id) });
    return !!(res && res.success);
}

async function getUserPersonalDictionaryEntries(userId) {
    const res = await request('POST', '/user-dict/list', { userId: scopeId(userId) });
    return Array.isArray(res) ? res : [];
}

// --- Ignore/Allow Channels ---
async function addIgnoreChannel(guildId, channelId) {
    const res = await request('POST', '/channels/ignore/add', { guildId: scopeId(guildId), channelId });
    return !!(res && res.success);
}

async function removeIgnoreChannel(guildId, channelId) {
    const res = await request('POST', '/channels/ignore/remove', { guildId: scopeId(guildId), channelId });
    return !!(res && res.success);
}

async function getIgnoreChannels(guildId) {
    const res = await request('POST', '/channels/ignore/list', { guildId: scopeId(guildId) });
    return res || [];
}

async function addAllowChannel(guildId, channelId) {
    const res = await request('POST', '/channels/allow/add', { guildId: scopeId(guildId), channelId });
    return !!(res && res.success);
}

async function removeAllowChannel(guildId, channelId) {
    const res = await request('POST', '/channels/allow/remove', { guildId: scopeId(guildId), channelId });
    return !!(res && res.success);
}

async function getAllowChannels(guildId) {
    const res = await request('POST', '/channels/allow/list', { guildId: scopeId(guildId) });
    return res || [];
}

// --- Channel Pairs ---
async function addChannelPair(guildId, voiceId, textId) {
    const res = await request('POST', '/channels/pair/add', { guildId: scopeId(guildId), voiceId, textId });
    return !!(res && res.success);
}

async function removeChannelPair(guildId, voiceId) {
    const res = await request('POST', '/channels/pair/remove', { guildId: scopeId(guildId), voiceId });
    return !!(res && res.success);
}

async function getChannelPair(guildId, voiceId) {
    const pair = await request('POST', '/channels/pair/get', { guildId: scopeId(guildId), voiceId });
    return withRawGuildId(pair);
}

async function getAllChannelPairs(guildId) {
    const res = await request('POST', '/channels/pair/all', { guildId: scopeId(guildId) });
    return res || [];
}

// --- Voice Presets ---
async function addVoicePreset(userId, name, settings) {
    const res = await request('POST', '/presets/add', { userId: scopeId(userId), name, settings });
    return !!(res && res.success);
}

async function updateVoicePreset(userId, presetId, name, settings) {
    const res = await request('POST', '/presets/update', { userId: scopeId(userId), id: presetId, name, settings });
    return !!(res && res.success);
}

async function getVoicePresets(userId) {
    const res = await request('POST', '/presets/list', { userId: scopeId(userId) });
    if (!Array.isArray(res)) return [];
    return res.map((preset) => {
        if (!preset || typeof preset !== 'object') return preset;
        return { ...preset, user_id: unscopeId(preset.user_id) };
    });
}

async function getVoicePreset(presetId) {
    const preset = await request('POST', '/presets/get', { id: presetId });
    if (!preset || typeof preset !== 'object') return preset;
    if (BOT_DB_NAMESPACE_PREFIX && typeof preset.user_id === 'string' && !preset.user_id.startsWith(BOT_DB_NAMESPACE_PREFIX)) {
        return null;
    }
    return { ...preset, user_id: unscopeId(preset.user_id) };
}

async function deleteVoicePreset(presetId, userId) {
    await request('POST', '/presets/delete', { id: presetId, userId: scopeId(userId) });
}

// --- AutoVC ---
async function addAutoVCGenerator(guildId, channelId, categoryId, textChannelId, namingPattern) {
    await request('POST', '/autovc/gen/add', { guildId: scopeId(guildId), channelId, categoryId, textChannelId, namingPattern });
}

async function getAutoVCGenerator(guildId, channelId) {
    const generator = await request('POST', '/autovc/gen/get', { guildId: scopeId(guildId), channelId });
    return withRawGuildId(generator);
}

async function getAutoVCGenerators(guildId) {
    const res = await request('POST', '/autovc/gen/list', { guildId: scopeId(guildId) });
    if (!Array.isArray(res)) return [];
    return res.map((generator) => withRawGuildId(generator));
}

async function removeAutoVCGenerator(guildId, channelId) {
    await request('POST', '/autovc/gen/remove', { guildId: scopeId(guildId), channelId });
}

async function addActiveChannel(voiceId, archiveChannelId, guildId, ownerId) {
    await request('POST', '/autovc/active/add', {
        voiceId: scopeId(voiceId),
        archiveChannelId,
        guildId: scopeId(guildId),
        ownerId: scopeId(ownerId)
    });
}

async function getActiveChannel(voiceId) {
    const activeChannel = await request('POST', '/autovc/active/get', { voiceId: scopeId(voiceId) });
    if (!activeChannel || typeof activeChannel !== 'object') return activeChannel;

    return {
        ...activeChannel,
        voice_channel_id: unscopeId(activeChannel.voice_channel_id),
        guild_id: unscopeId(activeChannel.guild_id),
        owner_id: unscopeId(activeChannel.owner_id)
    };
}

async function removeActiveChannel(voiceId) {
    await request('POST', '/autovc/active/remove', { voiceId: scopeId(voiceId) });
}

async function getActiveChannelByOwner(ownerId) {
    const activeChannel = await request('POST', '/autovc/active/get-owner', { ownerId: scopeId(ownerId) });
    if (!activeChannel || typeof activeChannel !== 'object') return activeChannel;

    return {
        ...activeChannel,
        voice_channel_id: unscopeId(activeChannel.voice_channel_id),
        guild_id: unscopeId(activeChannel.guild_id),
        owner_id: unscopeId(activeChannel.owner_id)
    };
}

// --- Voice Channel Claims (Multi-Bot Coordination) ---
async function claimVoiceChannel(guildId, voiceChannelId, ownerId, ttlSeconds = 90) {
    const res = await request('POST', '/vc-claims/claim', {
        guildId: scopeId(guildId),
        voiceChannelId: scopeId(voiceChannelId),
        ownerId,
        ttlSeconds,
    });

    if (!res || !res.success) {
        return {
            success: false,
            claimed: false,
            owner_id: null,
            expires_at: null,
        };
    }

    return {
        ...res,
        guild_id: unscopeId(res.guild_id),
        voice_channel_id: unscopeId(res.voice_channel_id),
    };
}

async function renewVoiceChannelClaim(guildId, voiceChannelId, ownerId, ttlSeconds = 90) {
    const res = await request('POST', '/vc-claims/heartbeat', {
        guildId: scopeId(guildId),
        voiceChannelId: scopeId(voiceChannelId),
        ownerId,
        ttlSeconds,
    });

    if (!res || !res.success) {
        return {
            success: false,
            renewed: false,
        };
    }

    return {
        ...res,
        guild_id: unscopeId(res.guild_id),
        voice_channel_id: unscopeId(res.voice_channel_id),
    };
}

async function releaseVoiceChannel(guildId, voiceChannelId, ownerId) {
    const res = await request('POST', '/vc-claims/release', {
        guildId: scopeId(guildId),
        voiceChannelId: scopeId(voiceChannelId),
        ownerId,
    });

    if (!res || !res.success) {
        return {
            success: false,
            released: false,
        };
    }

    return {
        ...res,
        guild_id: unscopeId(res.guild_id),
        voice_channel_id: unscopeId(res.voice_channel_id),
    };
}

async function releaseVoiceChannelClaimsByOwner(ownerId) {
    const res = await request('POST', '/vc-claims/release-owner', { ownerId });
    if (!res || !res.success) {
        return {
            success: false,
            released: 0,
        };
    }
    return res;
}

// --- Join Requests (Cross-Bot Assignment) ---
async function createJoinRequest(guildId, voiceChannelId, textChannelId, requestedBy, ttlSeconds = 120) {
    const res = await request('POST', '/join-requests/create', {
        guildId: scopeId(guildId),
        voiceChannelId: scopeId(voiceChannelId),
        textChannelId,
        requestedBy,
        ttlSeconds,
    });

    if (!res || !res.success) return null;
    return {
        ...res,
        guild_id: unscopeId(res.guild_id),
        voice_channel_id: unscopeId(res.voice_channel_id),
    };
}

async function dispatchJoinRequest(ownerId, busyGuildIds = [], eligibleGuildIds = [], claimTtlSeconds = 45) {
    const scopedBusyGuildIds = Array.isArray(busyGuildIds) ? busyGuildIds.map((guildId) => scopeId(guildId)) : [];
    const scopedEligibleGuildIds = Array.isArray(eligibleGuildIds) ? eligibleGuildIds.map((guildId) => scopeId(guildId)) : [];
    const res = await request('POST', '/join-requests/dispatch', {
        ownerId,
        busyGuildIds: scopedBusyGuildIds,
        eligibleGuildIds: scopedEligibleGuildIds,
        claimTtlSeconds,
    });

    if (!res || typeof res !== 'object') return null;
    return {
        ...res,
        guild_id: unscopeId(res.guild_id),
        voice_channel_id: unscopeId(res.voice_channel_id),
    };
}

async function requeueJoinRequest(id, ownerId, ttlSeconds = 120) {
    const res = await request('POST', '/join-requests/requeue', {
        id,
        ownerId,
        ttlSeconds,
    });

    if (!res || !res.success) {
        return {
            success: false,
            requeued: false,
        };
    }
    return res;
}

async function completeJoinRequest(id, ownerId, success, message = '') {
    const res = await request('POST', '/join-requests/complete', {
        id,
        ownerId,
        success,
        message,
    });
    if (!res || !res.success) {
        return {
            success: false,
            completed: false,
        };
    }
    return res;
}

module.exports = {
    getCurrentMonth,
    getGuildUsage, addCharacterUsage, resetGuildUsage, getAllGuildUsage,
    addLicenseKey, getLicenseKeyInfo, getServerActivationInfo, activateLicense, deactivateLicense,
    getUserSettings, setUserSpeakerId, setUserSpeed, setUserPitch, resetUserSettings, setUserAutoJoin,
    setUserActiveSpeech,
    getGuildSettings, setGuildAutoJoin, setGuildReadJoin, setGuildReadLeave, setGuildActiveSpeech,
    setGuildDefaultSpeaker, resetGuildDefaultSpeaker,
    addDictionaryEntry, removeDictionaryEntry, removeDictionaryEntryById, getDictionaryEntries,
    importDictionary, clearDictionary,
    addUserPersonalDictionaryEntry, removeUserPersonalDictionaryEntryById, getUserPersonalDictionaryEntries,

    addIgnoreChannel, removeIgnoreChannel, getIgnoreChannels,
    addAllowChannel, removeAllowChannel, getAllowChannels,

    addChannelPair, removeChannelPair, getChannelPair, getAllChannelPairs,
    addVoicePreset, getVoicePresets, getVoicePreset, deleteVoicePreset, updateVoicePreset,

    addAutoVCGenerator, getAutoVCGenerator, getAutoVCGenerators, removeAutoVCGenerator,
    addActiveChannel, getActiveChannel, removeActiveChannel, getActiveChannelByOwner,

    claimVoiceChannel, renewVoiceChannelClaim, releaseVoiceChannel, releaseVoiceChannelClaimsByOwner,
    createJoinRequest, dispatchJoinRequest, requeueJoinRequest, completeJoinRequest
};
