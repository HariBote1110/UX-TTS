const {
    joinVoiceChannel,
    getVoiceConnection,
    VoiceConnectionStatus,
    entersState,
    createAudioPlayer,
    AudioPlayerStatus,
    createAudioResource,
    StreamType
} = require('@discordjs/voice');
const { Readable } = require('stream');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { synthesize } = require('./services/synthesizer');
const {
    getUserSettings,
    setUserSpeakerId,
    setUserSpeed,
    setUserPitch,
    resetUserSettings,
    getGuildUsage,
    addCharacterUsage,
    claimVoiceChannel,
    renewVoiceChannelClaim,
    releaseVoiceChannel,
} = require('./database');
const { sendErrorLog } = require('./errorLogger');
const { incrementRequest } = require('./utils/statsManager');
const recoveryManager = require('./utils/recoveryManager'); // ★追加
const easterEggManager = require('./utils/easterEggManager'); // ★イースターエッグ
const connectionQueue = require('./voice/ConnectionQueue');
const dailyStats = require('./utils/dailyStats');
const { safeDestroy } = require('./utils/voiceUtils');
const { notifyCharLimitExceeded } = require('./utils/limitExceededNotifier');

// ==========================================
// ★ Layer A 設定 (一括管理)
// ==========================================
const CONFIG = {
    CHUNK_ENABLED: true,
    PRELOAD_ENABLED: true,
    MAX_PRELOAD_COUNT: 5, // ★ 同時に先読みする最大チャンク数
    LOG_ENABLED: true,

    MIN_CHUNK_LENGTH: 10,
    DEFAULT_SPEAKER_ID: parseInt(process.env.SPEAKER_ID, 10) || 1,
    DEFAULT_SPEED: 1.0,
    DEFAULT_PITCH: 0.0,
    VVX_CHAR_THRESHOLD: parseInt(process.env.VOICEVOX_CHAR_THRESHOLD, 10),
    OJT_COST_FACTOR: 0.5,
    // JST 05:00–15:00 はVOICEVOX消費文字数を半分に割り引く
    VVX_HALF_COST_JST_START: 5,
    VVX_HALF_COST_JST_END: 15,
    VVX_HALF_COST_FACTOR: 0.5,
};
// ==========================================

/**
 * 現在時刻がVOICEVOX割引時間帯（JST 05:00–15:00）かどうかを返す。
 * JST = UTC+9
 */
function isVvxHalfCostPeriod() {
    const jstHour = (new Date().getUTCHours() + 9) % 24;
    return jstHour >= CONFIG.VVX_HALF_COST_JST_START && jstHour < CONFIG.VVX_HALF_COST_JST_END;
}

const OPENJTALK_API_URL = process.env.OPENJTALK_API_URL;
if (!OPENJTALK_API_URL && CONFIG.VVX_CHAR_THRESHOLD > 0) {
    console.warn('OPENJTALK_API_URLが.envに設定されていません。Open JTalkフォールバックは無効になります。');
}

const parseBoolean = (value, defaultValue) => {
    if (value == null || value === '') return defaultValue;
    const lowered = String(value).toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(lowered)) return true;
    if (['0', 'false', 'no', 'off'].includes(lowered)) return false;
    return defaultValue;
};

const ENABLE_VC_CLAIM = parseBoolean(process.env.ENABLE_VC_CLAIM, true);
const VC_CLAIM_TTL_SECONDS = Number.parseInt(process.env.VC_CLAIM_TTL_SECONDS || '90', 10);
const NORMALISED_VC_CLAIM_TTL_SECONDS = Number.isInteger(VC_CLAIM_TTL_SECONDS) && VC_CLAIM_TTL_SECONDS > 0 ? VC_CLAIM_TTL_SECONDS : 90;
const VC_CLAIM_HEARTBEAT_MS = Math.max(15000, Math.floor((NORMALISED_VC_CLAIM_TTL_SECONDS * 1000) / 3));
const CONNECT_READY_TIMEOUT_MS = 30_000;
const CONNECT_RETRY_LIMIT = 2;
const CONNECT_RETRY_BASE_DELAY_MS = 1_500;

function resolveBotInstanceId(client) {
    const explicit = String(process.env.BOT_INSTANCE_ID || '').trim();
    const shardId = Array.isArray(client?.shard?.ids) && Number.isInteger(client.shard.ids[0]) ? client.shard.ids[0] : 'single';
    const botBase = explicit || client?.user?.id || process.env.CLIENT_ID || 'unknown-bot';
    return `${botBase}:shard-${shardId}`;
}

class VoiceConnectionManager {
    constructor(client, guildId) {
        this.client = client;
        this.guildId = guildId;
        this.botInstanceId = resolveBotInstanceId(client);
        this.audioPlayer = createAudioPlayer();
        this.connection = null;
        this.currentVoiceChannel = null;
        this.currentTextChannelId = null;
        this.connectedClaimChannelId = null;
        this.claimHeartbeatTimer = null;
        this.lastConnectErrorCode = null;
        this.messageQueue = [];
        this.isPlaying = false;
        this.isPlaying = false;
        this.isIntentionalDisconnect = false;
        this.isReconnecting = false; // ★追加: 再接続フラグ

        this.speakingUsers = new Set();
        this.activeSpeechTimeoutCount = 0;
        this.warningMessageId = null;
        this.playTimer = null;
        this.forcePlayOneTime = false;
        this.sessionCharCount = 0;

        this._setupAudioPlayerListeners();
    }

    async connect(channel, textChannelId) {
        return connectionQueue.add(() => this._connectInternal(channel, textChannelId));
    }

    async _connectInternal(channel, textChannelId) {
        if (!channel) return false;
        this.lastConnectErrorCode = null;

        if (this.connection && this.currentVoiceChannel && this.currentVoiceChannel.id === channel.id) {
            this.currentTextChannelId = textChannelId;
            if (CONFIG.LOG_ENABLED) console.log(`[${this.guildId}] 接続維持: 読み上げチャンネルを ${textChannelId || '未定'} に更新しました。`);
            this.updateSelfDeaf();

            // ★追加: 接続情報を更新
            recoveryManager.setConnection(this.guildId, channel.id, textChannelId);
            await this._renewClaim(channel.id);
            this._startClaimHeartbeat(channel.id);

            return true;
        }

        const claimResult = await this._claimChannel(channel.id);
        if (!claimResult.claimed) {
            this._handleClaimFailure(channel.id, claimResult);
            return false;
        }

        const previousChannelId = this.connectedClaimChannelId || this.currentVoiceChannel?.id || null;

        // --- 再接続フロー開始 ---
        this.isReconnecting = true;

        safeDestroy(this.connection);
        const existing = getVoiceConnection(this.guildId);
        safeDestroy(existing);

        await new Promise(r => setTimeout(r, 500));

        this.isReconnecting = false; // 旧接続の破棄が終わったのでフラグを下ろす
        // --- 再接続フロー終了 ---

        this.currentVoiceChannel = channel;
        const shouldDeaf = await this._shouldSelfDeaf();

        for (let attempt = 0; attempt <= CONNECT_RETRY_LIMIT; attempt++) {
            try {
                this.connection = joinVoiceChannel({
                    channelId: channel.id,
                    guildId: this.guildId,
                    adapterCreator: channel.guild.voiceAdapterCreator,
                    selfDeaf: shouldDeaf,
                });

                await this._waitUntilConnectionReady(this.connection, CONNECT_READY_TIMEOUT_MS);

                this.connection.subscribe(this.audioPlayer);
                this.currentTextChannelId = textChannelId;

                if (CONFIG.LOG_ENABLED) console.log(`[${this.guildId}] ${channel.name} に接続しました。`);
                this._setupConnectionListeners();
                this.connectedClaimChannelId = channel.id;
                this._startClaimHeartbeat(channel.id);

                // ★追加: 接続情報を保存
                recoveryManager.setConnection(this.guildId, channel.id, textChannelId);

                if (previousChannelId && previousChannelId !== channel.id) {
                    this._releaseClaim(previousChannelId);
                }

                return true;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const retryable = this._isRetryableConnectError(error);
                const canRetry = retryable && attempt < CONNECT_RETRY_LIMIT;
                const attemptLabel = `${attempt + 1}/${CONNECT_RETRY_LIMIT + 1}`;

                if (canRetry) {
                    console.warn(`[${this.guildId}] VC接続失敗 (${attemptLabel})。再試行します: ${message}`);
                } else {
                    console.error(`[${this.guildId}] VCへの接続に失敗しました (${attemptLabel}): ${message}`);
                    sendErrorLog(this.client, error, { place: 'VoiceConnectionManager.connect', guildId: this.guildId });
                }

                safeDestroy(this.connection);
                this.connection = null;

                if (canRetry) {
                    await new Promise((resolve) => setTimeout(resolve, this._getConnectRetryDelayMs(attempt)));
                    continue;
                }

                await this._releaseClaim(channel.id);
                this._resetState(false);
                return false;
            }
        }

        await this._releaseClaim(channel.id);
        this._resetState(false);
        return false;
    }

    disconnect(isAutoDisconnect = false) {
        this.isIntentionalDisconnect = !isAutoDisconnect;
        const connection = getVoiceConnection(this.guildId);
        if (connection) {
            safeDestroy(connection);
        } else {
            this._resetState(isAutoDisconnect);
        }
    }

    // ★修正: テキストチャンネルが設定されたら、リカバリ情報も即座に更新する
    setTextChannelId(textChannelId) {
        this.currentTextChannelId = textChannelId;

        // 既にVCに接続している場合、新しいテキストチャンネルIDで保存し直す
        if (this.currentVoiceChannel) {
            recoveryManager.setConnection(this.guildId, this.currentVoiceChannel.id, textChannelId);
        }
    }

    async updateSelfDeaf() {
        if (!this.isActive() || !this.currentVoiceChannel) return;

        // 接続が破棄されている、または切断中の場合は実行しない
        if (this.connection.state.status === VoiceConnectionStatus.Destroyed ||
            this.connection.state.status === VoiceConnectionStatus.Disconnected) return;

        const shouldDeaf = await this._shouldSelfDeaf();
        try {
            joinVoiceChannel({
                channelId: this.currentVoiceChannel.id,
                guildId: this.guildId,
                adapterCreator: this.currentVoiceChannel.guild.voiceAdapterCreator,
                selfDeaf: shouldDeaf,
            });
        } catch (e) { console.error(`[${this.guildId}] updateSelfDeaf Error: ${e.message}`); }
    }

    async _shouldSelfDeaf() {
        if (!this.currentVoiceChannel) return true;
        const members = this.currentVoiceChannel.members.filter(m => !m.user.bot);
        for (const [memberId, member] of members) {
            const settings = await getUserSettings(this.guildId, memberId);
            if (settings && settings.active_speech === 1) return false;
        }
        return true;
    }

    _setupConnectionListeners() {
        if (!this.connection) return;

        // ★追加: ネットワークエラー/IP Discovery失敗などをハンドルする
        this.connection.on('error', (error) => {
            if (this._isRetryableConnectError(error)) {
                console.warn(`[${this.guildId}] VoiceConnection 一時エラー: ${error.message}`);
            } else {
                console.error(`[${this.guildId}] VoiceConnection Error:`, error.message);
                sendErrorLog(this.client, error, { place: 'VoiceConnectionManager.connection.on(error)', guildId: this.guildId });
            }

            // 接続不可状態になった場合はクリーンアップ
            safeDestroy(this.connection);
        });

        this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
            try {
                await Promise.race([
                    entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
                    entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
                ]);
                if (CONFIG.LOG_ENABLED) console.log(`[${this.guildId}] VCに再接続しました。`);
            } catch (error) {
                if (CONFIG.LOG_ENABLED) console.log(`[${this.guildId}] VCからの切断（自動復帰失敗）`);
                if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
                    safeDestroy(this.connection);
                } else {
                    this._resetState(true);
                    this.client.emit('managerDestroyed', this.guildId);
                }
            }
        });

        this.connection.on(VoiceConnectionStatus.Destroyed, () => {
            if (CONFIG.LOG_ENABLED) console.log(`[${this.guildId}] VCから切断されました (Destroyed)`);
            const isAutoDisconnect = !this.isIntentionalDisconnect;

            // ★修正: 再接続中の場合は、マネージャーを破棄せず状態リセットも行わない
            if (this.isReconnecting) {
                if (CONFIG.LOG_ENABLED) console.log(`[${this.guildId}] 再接続中のため、マネージャーの破棄をスキップします。`);
                return;
            }

            this._resetState(isAutoDisconnect);
            this.isIntentionalDisconnect = false;
            this.client.emit('managerDestroyed', this.guildId);
        });

        if (this.connection.receiver) {
            this.connection.receiver.speaking.on('start', (userId) => {
                this.speakingUsers.add(userId);
            });
            this.connection.receiver.speaking.on('end', (userId) => {
                this.speakingUsers.delete(userId);
            });
        }
    }

    _setupAudioPlayerListeners() {
        this.audioPlayer.on(AudioPlayerStatus.Idle, () => {
            this.isPlaying = false;
            this._playNextMessage();
        });
        this.audioPlayer.on('error', error => {
            console.error(`[${this.guildId}] AudioPlayerエラー: ${error.message}`);
            this.isPlaying = false;
            this._playNextMessage();
        });
    }

    _isRetryableConnectError(error) {
        if (!error) return false;

        if (error.name === 'AbortError') return true;

        const message = String(error.message || error);
        return message.includes('Unexpected server response: 521') ||
            message.includes('Unexpected server response: 522') ||
            message.includes('Unexpected server response: 520') ||
            message.includes('ETIMEDOUT') ||
            message.includes('ECONNRESET');
    }

    _getConnectRetryDelayMs(attempt) {
        const exponent = Math.max(0, attempt);
        return Math.min(10_000, CONNECT_RETRY_BASE_DELAY_MS * (2 ** exponent));
    }

    async _waitUntilConnectionReady(connection, timeoutMs) {
        let onError = null;
        const connErrorPromise = new Promise((_, reject) => {
            onError = (error) => reject(error);
            connection.once('error', onError);
        });

        try {
            await Promise.race([
                entersState(connection, VoiceConnectionStatus.Ready, timeoutMs),
                connErrorPromise
            ]);
        } finally {
            if (onError) {
                connection.off('error', onError);
            }
        }
    }

    _resetState(isAutoDisconnect) {
        const claimChannelId = this.connectedClaimChannelId || this.currentVoiceChannel?.id || null;

        // ★追加: 正常な切断フロー(キック含む)の場合は、リカバリリストから削除する
        // ※ プロセスが強制終了した場合はこのメソッドは呼ばれないため、リストに残る -> 再起動時に復帰可能
        recoveryManager.removeConnection(this.guildId);
        this._stopClaimHeartbeat();
        if (claimChannelId) {
            this._releaseClaim(claimChannelId);
        }

        this.audioPlayer.stop(true);
        this.messageQueue = [];
        this.speakingUsers.clear();
        this.activeSpeechTimeoutCount = 0;
        this.warningMessageId = null;
        if (this.playTimer) clearTimeout(this.playTimer);
        this.isPlaying = false;
        this.sessionCharCount = 0;
        if (isAutoDisconnect && this.currentTextChannelId) {
            this._sendAutoDisconnectMessage();
        }
        this.connection = null;
        this.currentVoiceChannel = null;
        this.currentTextChannelId = null;
        this.connectedClaimChannelId = null;
    }

    _sendAutoDisconnectMessage() {
        try {
            const channel = this.client.channels.cache.get(this.currentTextChannelId);
            if (channel && channel.isTextBased()) {
                const embed = new EmbedBuilder()
                    .setTitle('👋 自動切断')
                    .setDescription('VCの参加者が0人になったため、自動切断しました。')
                    .setColor(0x00AAFF);
                channel.send({ embeds: [embed] }).catch(e => { });
            }
        } catch (e) { }
    }

    isActive() { return this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed; }
    getTextChannelId() { return this.currentTextChannelId; }
    getVoiceChannel() { return this.currentVoiceChannel; }
    getLastConnectErrorCode() { return this.lastConnectErrorCode; }
    getSessionCharCount() { return this.sessionCharCount; }

    _handleClaimFailure(channelId, claimResult) {
        this.lastConnectErrorCode = 'claimed_by_other_bot';
        if (CONFIG.LOG_ENABLED) {
            const owner = claimResult.owner_id || 'unknown';
            console.log(`[${this.guildId}] VC接続をスキップ: ${channelId} は別Botが担当中です (${owner})`);
        }
    }

    async _claimChannel(voiceChannelId) {
        if (!ENABLE_VC_CLAIM) {
            return { claimed: true };
        }

        const result = await claimVoiceChannel(this.guildId, voiceChannelId, this.botInstanceId, NORMALISED_VC_CLAIM_TTL_SECONDS);
        if (!result.success) {
            // Layer-D 不達時は従来動作を優先
            if (CONFIG.LOG_ENABLED) {
                console.warn(`[${this.guildId}] VC claim API未応答のため接続を許可します。`);
            }
            return { claimed: true };
        }
        return result;
    }

    async _renewClaim(voiceChannelId) {
        if (!ENABLE_VC_CLAIM) return { success: true, renewed: true };
        return renewVoiceChannelClaim(this.guildId, voiceChannelId, this.botInstanceId, NORMALISED_VC_CLAIM_TTL_SECONDS);
    }

    async _releaseClaim(voiceChannelId) {
        if (!ENABLE_VC_CLAIM || !voiceChannelId) return { success: true, released: true };
        return releaseVoiceChannel(this.guildId, voiceChannelId, this.botInstanceId);
    }

    _startClaimHeartbeat(voiceChannelId) {
        this._stopClaimHeartbeat();
        if (!ENABLE_VC_CLAIM || !voiceChannelId) return;

        this.claimHeartbeatTimer = setInterval(async () => {
            try {
                const result = await this._renewClaim(voiceChannelId);
                if (result.success && result.renewed === false) {
                    console.warn(`[${this.guildId}] VC claim を維持できなかったため切断します。`);
                    this.disconnect(true);
                }
            } catch (error) {
                console.warn(`[${this.guildId}] VC claim heartbeat error: ${error.message}`);
            }
        }, VC_CLAIM_HEARTBEAT_MS);

        if (typeof this.claimHeartbeatTimer.unref === 'function') {
            this.claimHeartbeatTimer.unref();
        }
    }

    _stopClaimHeartbeat() {
        if (this.claimHeartbeatTimer) {
            clearInterval(this.claimHeartbeatTimer);
            this.claimHeartbeatTimer = null;
        }
    }

    async getSettingsForUser(userId) {
        const settings = await getUserSettings(this.guildId, userId);
        const hasUserSpeaker = settings?.speaker_id != null;
        const guildDefaultSpeakerId = settings?.guild_default_speaker_id ?? CONFIG.DEFAULT_SPEAKER_ID;
        const guildDefaultSpeakerType = settings?.guild_default_speaker_type ?? 'voicevox';

        return {
            speakerId: hasUserSpeaker ? settings.speaker_id : guildDefaultSpeakerId,
            speakerType: hasUserSpeaker ? (settings?.speaker_type ?? 'voicevox') : guildDefaultSpeakerType,
            speed: settings?.speed ?? CONFIG.DEFAULT_SPEED,
            pitch: settings?.pitch ?? CONFIG.DEFAULT_PITCH
        };
    }
    async setSpeakerId(userId, id, type = 'voicevox') { await setUserSpeakerId(this.guildId, userId, id, type); }
    async setSpeed(userId, speed) { await setUserSpeed(this.guildId, userId, speed); }
    async setPitch(userId, pitch) { await setUserPitch(this.guildId, userId, pitch); }
    async resetSettings(userId) { await resetUserSettings(this.guildId, userId); }

    _splitText(text) {
        const parts = text.split(/(?<=[、。！？,.?!\n])/g);
        const chunks = [];
        let currentChunk = '';
        for (const part of parts) {
            const nextChunk = currentChunk + part;
            if (nextChunk.length < CONFIG.MIN_CHUNK_LENGTH) {
                currentChunk = nextChunk;
            } else {
                chunks.push(nextChunk);
                currentChunk = '';
            }
        }
        if (currentChunk.length > 0) chunks.push(currentChunk);
        return chunks;
    }

    async addQueue(text, userId) {
        // ★ イースターエッグチェック（チャンク分割より前に実施）
        const easterEgg = easterEggManager.findMatch(text, userId);
        if (easterEgg) {
            if (CONFIG.LOG_ENABLED) console.log(`[${this.guildId}] 🥚 Easter Egg queued: ${easterEgg.description}`);
            this.messageQueue.push({
                text: text,
                userId,
                easterEggPath: easterEgg.audioPath,
                easterEggVolume: easterEgg.volume,
                addedAt: Date.now(),
                isFirstChunk: true,
                audioBuffer: null
            });
            if (!this.isPlaying) { this._playNextMessage(); }
            return; // 通常処理をスキップ
        }

        const usage = await getGuildUsage(this.guildId);
        if (usage.limitExceeded) {
            await notifyCharLimitExceeded(this.client, this.currentTextChannelId, this.guildId);
            return;
        }

        // セッション・日次統計を記録 (実読み上げ文字数)
        this.sessionCharCount += text.length;
        dailyStats.record(this.guildId, text.length);

        const userSettings = await this.getSettingsForUser(userId);
        const isUserOjt = userSettings.speakerType === 'ojt';
        const isVvxLimitReached = usage.useOjt;
        const isForcedOjt = !isUserOjt && isVvxLimitReached;
        const useOjt = isUserOjt || isForcedOjt;

        let chunks = [text];

        if (CONFIG.CHUNK_ENABLED && !useOjt) {
            if (text.length > CONFIG.MIN_CHUNK_LENGTH * 1.5) {
                if (CONFIG.LOG_ENABLED) console.log(`[${this.guildId}] 🔄 Chunking... (Len: ${text.length})`);
                chunks = this._splitText(text);
            }
        }

        const timestamp = Date.now();

        for (const [index, chunkText] of chunks.entries()) {
            let cost = chunkText.length;
            if (useOjt) {
                if (isVvxHalfCostPeriod()) {
                    // 割引時間帯（JST 05:00–15:00）はOJT消費を0に
                    cost = 0;
                } else {
                    cost = isVvxLimitReached ? chunkText.length * 1.0 : chunkText.length * CONFIG.OJT_COST_FACTOR;
                }
            } else if (isVvxHalfCostPeriod()) {
                // JST 05:00–15:00 はVOICEVOX消費文字数を半分に割り引く
                cost = chunkText.length * CONFIG.VVX_HALF_COST_FACTOR;
            }

            await addCharacterUsage(this.guildId, cost);

            this.messageQueue.push({
                text: chunkText,
                userId,
                forcedOjt: isForcedOjt,
                addedAt: timestamp,
                isFirstChunk: index === 0,
                audioBuffer: null
            });
        }

        const threshold = CONFIG.VVX_CHAR_THRESHOLD;
        if (!useOjt && threshold > 0 && usage.count < threshold && (usage.count + text.length) >= threshold) {
            this._notifyOjtSwitch(threshold);
        }

        if (!this.isPlaying) { this._playNextMessage(); }
        else { this._prefetchChunks(); }
    }

    _notifyOjtSwitch(threshold) {
        if (!this.currentTextChannelId) return;
        const ch = this.client.channels.cache.get(this.currentTextChannelId);
        if (ch) {
            const embed = new EmbedBuilder()
                .setTitle('⚠️ お知らせ')
                .setDescription(`VOICEVOX読み上げ文字数閾値 (${threshold.toLocaleString()}文字) に到達しました。\nこれ以降はOpen JTalkでの読み上げに切り替わります。`)
                .setColor(0xFEE75C);
            ch.send({ embeds: [embed] }).catch(() => { });
        }
    }

    forcePlayCurrent() {
        if (this.playTimer) clearTimeout(this.playTimer);
        this.forcePlayOneTime = true;
        this._cleanupWarningMessage();
        this._playNextMessage();
    }
    skipCurrent() {
        if (this.playTimer) clearTimeout(this.playTimer);
        this.messageQueue.shift();
        this._cleanupWarningMessage();
        this.isPlaying = false;
        this.activeSpeechTimeoutCount = 0;
        this._playNextMessage();
    }
    _cleanupWarningMessage() {
        if (this.warningMessageId && this.currentTextChannelId) {
            try {
                const ch = this.client.channels.cache.get(this.currentTextChannelId);
                if (ch) ch.messages.delete(this.warningMessageId).catch((err) => {
                    if (err.code !== 10008) {
                        console.error(`[${this.guildId}] Warning message delete error:`, err);
                    }
                });
            } catch (e) {
                console.error(`[${this.guildId}] _cleanupWarningMessage sync error:`, e);
            }
            this.warningMessageId = null;
        }
        this.activeSpeechTimeoutCount = 0;
    }

    async _shouldWaitForActiveSpeech() {
        if (this.forcePlayOneTime) return false;
        if (this.speakingUsers.size === 0) return false;
        for (const speakingUserId of this.speakingUsers) {
            const settings = await getUserSettings(this.guildId, speakingUserId);
            if (settings && settings.active_speech === 1) return true;
        }
        return false;
    }

    async _playNextMessage() {
        if (this.playTimer) { clearTimeout(this.playTimer); this.playTimer = null; }
        if (this.messageQueue.length === 0 || !this.isActive()) {
            this.isPlaying = false;
            return;
        }

        if (await this._shouldWaitForActiveSpeech()) {
            this.activeSpeechTimeoutCount++;
            if (this.activeSpeechTimeoutCount === 20 && !this.warningMessageId) this._sendActiveSpeechWarning();
            this.playTimer = setTimeout(() => this._playNextMessage(), 500);
            return;
        }

        this.forcePlayOneTime = false;
        this._cleanupWarningMessage();

        if (!this.connection || this.connection.state.status !== VoiceConnectionStatus.Ready) {
            try {
                if (this.connection) await entersState(this.connection, VoiceConnectionStatus.Ready, 2000);
                else throw new Error("Connection lost");
            } catch (e) {
                
                this.isPlaying = false;
                return;
            }
        }

        this.isPlaying = true;
        const item = this.messageQueue.shift();

        let resource = null;

        // ★ イースターエッグの処理（設定無視で直接再生）
        if (item.easterEggPath) {
            if (CONFIG.LOG_ENABLED) console.log(`[${this.guildId}] 🥚 Playing Easter Egg: ${item.easterEggPath} (Vol: ${item.easterEggVolume})`);
            resource = createAudioResource(item.easterEggPath, { inputType: StreamType.Arbitrary, inlineVolume: true });
            // 音量を設定
            if (resource.volume && item.easterEggVolume !== undefined) {
                resource.volume.setVolume(item.easterEggVolume);
            }
        } else if (item.audioBuffer) {
            resource = this._createResourceFromBuffer(item.audioBuffer);
        } else {
            const userSettings = await this.getSettingsForUser(item.userId);
            const useOjt = item.forcedOjt || (userSettings.speakerType === 'ojt');
            incrementRequest(useOjt);
            resource = await synthesize(item.text, {
                userId: item.userId,
                guildId: this.guildId,
                client: this.client,
                useOjt: useOjt,
                speakerId: userSettings.speakerId,
                speed: userSettings.speed,
                pitch: userSettings.pitch,
                logEnabled: CONFIG.LOG_ENABLED
            });
        }

        if (resource) {
            if (item.addedAt && item.isFirstChunk) {
                const totalLatency = Date.now() - item.addedAt;
                const chunkInfo = CONFIG.CHUNK_ENABLED ? '(Chunked)' : '(Full)';
                if (CONFIG.LOG_ENABLED) {
                    console.log(`[${this.guildId}] 🔊 Playback Started: ${totalLatency}ms (wait+gen) ${chunkInfo} | Text: "${item.text.substring(0, 10)}..."`);
                }
            }

            this.audioPlayer.play(resource);
            this._prefetchChunks();
        } else {
            this.isPlaying = false;
            this._playNextMessage();
        }
    }

    /**
     * 複数チャンクを並列に先読みする
     */
    async _prefetchChunks() {
        if (!CONFIG.PRELOAD_ENABLED || this.messageQueue.length === 0) return;

        // まだ音声生成が始まっていない（audioBufferがnull）チャンクを探し、
        // 設定された最大数（MAX_PRELOAD_COUNT）まで同時にリクエストを送る
        let prefetchedCount = 0;
        for (const item of this.messageQueue) {
            if (item.audioBuffer || item.easterEggPath) continue;

            const userSettings = await this.getSettingsForUser(item.userId);
            const useOjt = item.forcedOjt || (userSettings.speakerType === 'ojt');

            // プレフェッチ実行
            this._generateBufferForItem(item, useOjt);
            prefetchedCount++;

            if (prefetchedCount >= CONFIG.MAX_PRELOAD_COUNT) break;
        }
    }

    async _generateBufferForItem(item, useOjt) {
        if (item.isGenerating) return;
        item.isGenerating = true;

        incrementRequest(useOjt);

        try {
            const buffer = await synthesize(item.text, {
                userId: item.userId,
                guildId: this.guildId,
                client: this.client,
                useOjt: useOjt,
                speakerId: item.speakerId || (await this.getSettingsForUser(item.userId)).speakerId,
                speed: item.speed || (await this.getSettingsForUser(item.userId)).speed,
                pitch: item.pitch || (await this.getSettingsForUser(item.userId)).pitch,
                returnBuffer: true,
                logEnabled: CONFIG.LOG_ENABLED
            });

            if (buffer) {
                item.audioBuffer = buffer;
            }
        } catch (e) {
            console.error(`[${this.guildId}] Chunks Prefetch Error:`, e.message);
        } finally {
            item.isGenerating = false;
        }
    }

    _createResourceFromBuffer(buffer) {
        const stream = Readable.from(Buffer.from(buffer));
        return createAudioResource(stream, { inputType: StreamType.Arbitrary, inlineVolume: true });
    }

    async _sendActiveSpeechWarning() {
        if (!this.currentTextChannelId) return;
        try {
            const ch = this.client.channels.cache.get(this.currentTextChannelId);
            if (ch && ch.isTextBased()) {
                const row = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder().setCustomId('activespeech_skip').setLabel('スキップ').setStyle(ButtonStyle.Secondary),
                        new ButtonBuilder().setCustomId('activespeech_force').setLabel('強制再生').setStyle(ButtonStyle.Primary),
                    );
                const embed = new EmbedBuilder()
                    .setTitle('⏳ ActiveSpeech 待機中')
                    .setDescription('会話が続いているため、読み上げを10秒以上待機しています。')
                    .setColor(0xFEE75C);
                const msg = await ch.send({
                    embeds: [embed],
                    components: [row]
                });
                this.warningMessageId = msg.id;
            }
        } catch (e) { }
    }
}

module.exports = { VoiceConnectionManager, isVvxHalfCostPeriod };
