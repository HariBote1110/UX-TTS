const { 
    joinVoiceChannel, 
    getVoiceConnection,
    VoiceConnectionStatus,
    entersState,
    createAudioPlayer, 
    AudioPlayerStatus
} = require('@discordjs/voice');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { synthesize } = require('./services/synthesizer'); 
const { 
    getUserSettings, 
    setUserSpeakerId, 
    setUserSpeed, 
    setUserPitch, 
    resetUserSettings,
    getGuildUsage, 
    addCharacterUsage,
    getGuildSettings // ActiveSpeech (Server)のために必要
} = require('./database');
const { sendErrorLog } = require('./errorLogger');
const { incrementRequest } = require('./utils/statsManager');

// --- デフォルト設定 ---
const DEFAULT_SPEAKER_ID = parseInt(process.env.SPEAKER_ID, 10) || 1;
const DEFAULT_SPEED = 1.0;
const DEFAULT_PITCH = 0.0;
const VVX_CHAR_THRESHOLD = parseInt(process.env.VOICEVOX_CHAR_THRESHOLD, 10);
const TOTAL_CHAR_LIMIT = parseInt(process.env.TOTAL_CHAR_LIMIT, 10);
const OPENJTALK_API_URL = process.env.OPENJTALK_API_URL;
const OJT_COST_FACTOR = 0.5; 

if (!OPENJTALK_API_URL && VVX_CHAR_THRESHOLD > 0) {
    console.warn('OPENJTALK_API_URLが.envに設定されていません。Open JTalkフォールバックは無効になります。');
} else if (VVX_CHAR_THRESHOLD > 0) {
    console.log(`Open JTalk APIサーバー (${OPENJTALK_API_URL}) を使用する準備ができました。`);
}

/**
 * サーバーごとのボイス接続と読み上げを管理するクラス
 */
class VoiceConnectionManager {
    constructor(client, guildId) {
        this.client = client;
        this.guildId = guildId;
        this.audioPlayer = createAudioPlayer();
        this.connection = null;
        this.currentVoiceChannel = null;
        this.currentTextChannelId = null; 
        this.messageQueue = []; 
        this.isPlaying = false;
        this.isIntentionalDisconnect = false;
        
        // ★ 競合防止フラグ
        this.isConnecting = false;

        // ActiveSpeech用変数
        this.speakingUsers = new Set();
        this.activeSpeechTimeoutCount = 0; 
        this.warningMessageId = null;      
        this.playTimer = null;             
        this.forcePlayOneTime = false;     

        this._setupAudioPlayerListeners(); 
    }

    // --- 接続/切断 ---
    async connect(channel, textChannelId) {
        if (!channel) return false;

        // 競合防止: 既に接続処理中ならスキップ
        if (this.isConnecting) {
            return false;
        }

        // 既に同じVCにいるなら更新のみ
        if (this.connection && 
            this.connection.state.status !== VoiceConnectionStatus.Destroyed && 
            this.currentVoiceChannel && 
            this.currentVoiceChannel.id === channel.id) {
            
            this.currentTextChannelId = textChannelId;
            this.updateSelfDeaf();
            return true;
        }

        this.isConnecting = true; // ロック開始

        // 既存接続の安全な破棄 (Cannot destroy VoiceConnection - it has already been destroyed 対策)
        if (this.connection) {
            if (this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
                try {
                    this.connection.destroy();
                } catch (e) {
                    console.error(`[${this.guildId}] Connection destroy error:`, e.message);
                }
            }
            this.connection = null;
        }
        
        this.currentVoiceChannel = channel;
        const shouldDeaf = this._shouldSelfDeaf();

        try {
            this.connection = joinVoiceChannel({
                channelId: channel.id, guildId: this.guildId,
                adapterCreator: channel.guild.voiceAdapterCreator, 
                selfDeaf: shouldDeaf,
            });

            // 接続完了を待つ (タイムアウト20秒)
            await entersState(this.connection, VoiceConnectionStatus.Ready, 20_000);
            
            this.connection.subscribe(this.audioPlayer);
            this.currentTextChannelId = textChannelId; 
            
            console.log(`[${this.guildId}] 接続完了。`); // ログ抑制済み
            this._setupConnectionListeners(); 
            this.isConnecting = false; // ロック解除
            return true;

        } catch (error) {
            console.error(`[${this.guildId}] VC接続処理エラー:`, error.message);
            
            // エラー時も安全に破棄
            if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
                try { this.connection.destroy(); } catch(e){}
            }
            this.connection = null;
            
            if (error.name !== 'AbortError') {
                sendErrorLog(this.client, error, { place: 'VoiceConnectionManager.connect', guildId: this.guildId });
            }
            
            this._resetState(false);
            this.isConnecting = false; // ロック解除
            return false;
        }
    }

    disconnect(isAutoDisconnect = false) {
        // 接続処理中は切断しない
        if (this.isConnecting) return;

        this.isIntentionalDisconnect = !isAutoDisconnect;
        
        const connection = getVoiceConnection(this.guildId);
        
        if (connection) {
            // 既に破棄済みか確認
            if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
                try {
                    connection.destroy();
                } catch (e) {
                    console.error(`[${this.guildId}] Disconnect destroy error:`, e.message);
                }
            }
        } else {
            this._resetState(isAutoDisconnect);
        }
    }
    
    setTextChannelId(textChannelId) {
        this.currentTextChannelId = textChannelId;
    }

    // --- ActiveSpeech: スピーカーミュート(Self-Deaf)管理 ---
    updateSelfDeaf() {
        // ActiveSpeechのロジックがサーバー設定に変更されているため、このメソッドも修正が必要
        // ★ 修正: ActiveSpeechをサーバー設定から取得するようにロジック変更 (getUserSettingsではなくgetGuildSettingsを使用)
        if (!this.isActive() || !this.currentVoiceChannel || this.isConnecting) return;
        
        const shouldDeaf = this._shouldSelfDeaf();
        
        try {
            joinVoiceChannel({
                channelId: this.currentVoiceChannel.id,
                guildId: this.guildId,
                adapterCreator: this.currentVoiceChannel.guild.voiceAdapterCreator,
                selfDeaf: shouldDeaf, 
            });
        } catch (e) {
            console.error(`[${this.guildId}] SelfDeaf update failed:`, e.message);
        }
    }

    _shouldSelfDeaf() {
        // ActiveSpeechのロジックがサーバー設定に変更されているため、getGuildSettingsを使用
        const guildSettings = getGuildSettings(this.guildId);
        return !guildSettings.active_speech; 
    }

    // --- 内部リスナー ---
    _setupConnectionListeners() {
        if (!this.connection) return;
        
        this.connection.removeAllListeners(VoiceConnectionStatus.Disconnected);
        this.connection.removeAllListeners(VoiceConnectionStatus.Destroyed);

        this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
            try {
                await Promise.race([
                    entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
                    entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
                ]);
                console.log(`[${this.guildId}] VCに再接続しました。`); 
            } catch (error) {
                console.log(`[${this.guildId}] VC切断検知（自動復帰失敗）`);
                if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
                    try { this.connection.destroy(); } catch(e){}
                } else {
                    this._resetState(true); 
                    this.client.emit('managerDestroyed', this.guildId);
                }
            }
        });
        
        this.connection.on(VoiceConnectionStatus.Destroyed, () => {
            console.log(`[${this.guildId}] VCから切断されました。`);
            const isAutoDisconnect = !this.isIntentionalDisconnect;
            this._resetState(isAutoDisconnect);
            this.isIntentionalDisconnect = false;
            this.client.emit('managerDestroyed', this.guildId);
        });

        // ActiveSpeech: 発話検知
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
        this.audioPlayer.removeAllListeners(AudioPlayerStatus.Idle);
        this.audioPlayer.removeAllListeners('error');

        this.audioPlayer.on(AudioPlayerStatus.Idle, () => {
            this.isPlaying = false;
            this._playNextMessage(); 
        });
        this.audioPlayer.on('error', error => {
            console.error(`[${this.guildId}] AudioPlayerエラー: ${error.message}`);
            sendErrorLog(this.client, error, { place: 'AudioPlayer Error', guildId: this.guildId });
            this.isPlaying = false;
            this._playNextMessage(); 
        });
    }

    // --- 状態リセット ---
    _resetState(isAutoDisconnect) {
        console.log(`[${this.guildId}] Botの状態をリセットします。`);
        this.audioPlayer.stop(true); 
        this.messageQueue = []; 
        this.speakingUsers.clear();
        this.activeSpeechTimeoutCount = 0;
        this.warningMessageId = null;
        if (this.playTimer) clearTimeout(this.playTimer);
        
        this.isPlaying = false;
        if (isAutoDisconnect && this.currentTextChannelId) {
            this._sendAutoDisconnectMessage();
        }
        this.connection = null;
        this.currentVoiceChannel = null;
        this.currentTextChannelId = null;
    }
    _sendAutoDisconnectMessage() {
         try {
            const channel = this.client.channels.cache.get(this.currentTextChannelId);
            if (channel && channel.isTextBased()) {
                channel.send('👋 VCの参加者が0人になったため、自動切断しました。')
                    .catch(e => {
                        console.error(`[${this.guildId}] 自動切断メッセージ送信失敗:`, e.message);
                        sendErrorLog(this.client, e, { place: 'AutoDisconnect Message', guildId: this.guildId });
                    });
            }
        } catch (e) {
            console.error(`[${this.guildId}] 自動切断メッセージの送信に失敗(Sync):`, e.message);
            sendErrorLog(this.client, e, { place: 'AutoDisconnect Message (Sync)', guildId: this.guildId });
        }
    }

    // --- 状態取得 ---
    isActive() { return this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed; }
    getTextChannelId() { return this.currentTextChannelId; }
    getVoiceChannel() { return this.currentVoiceChannel; }

    // --- 設定 (DB連携) ---
    getSettingsForUser(userId) {
        const settings = getUserSettings(this.guildId, userId);
        return {
            speakerId: settings?.speaker_id ?? DEFAULT_SPEAKER_ID,
            speakerType: settings?.speaker_type ?? 'voicevox',
            speed: settings?.speed ?? DEFAULT_SPEED,
            pitch: settings?.pitch ?? DEFAULT_PITCH
        };
    }
    setSpeakerId(userId, id, type = 'voicevox') { setUserSpeakerId(this.guildId, userId, id, type); }
    setSpeed(userId, speed) { setUserSpeed(this.guildId, userId, speed); }
    setPitch(userId, pitch) { setUserPitch(this.guildId, userId, pitch); }
    resetSettings(userId) { resetUserSettings(this.guildId, userId); }

    // --- キュー追加 & 文字数カウント制御 ---
    addQueue(text, userId) {
        const usage = getGuildUsage(this.guildId);
        
        // 1. どちらのエンジンを使うか判定
        const userSettings = this.getSettingsForUser(userId);
        const isUserOjt = userSettings.speakerType === 'ojt';
        // 強制OJTモードかどうか (usage.useOjt = 制限超過フラグ)
        const isVvxLimitReached = usage.useOjt; 
        const isForcedOjt = !isUserOjt && isVvxLimitReached; 
        
        // 実際に使われるのがOJTかどうか
        const useOjt = isUserOjt || isForcedOjt;

        // 2. コスト計算
        let cost = text.length; // デフォルト 1.0倍

        if (useOjt) {
            if (isVvxLimitReached) {
                // 制限に引っかかって使えなくなった時 (または制限中にOJTを使う時) -> 1文字 (通常消費)
                cost = text.length * 1.0;
            } else {
                // VOICEVOXが利用可能だがOJTを使う時 -> 0.5文字 (割引)
                cost = text.length * OJT_COST_FACTOR;
            }
        }
        // VOICEVOX利用時はそのまま (1.0倍)

        // 3. 上限チェック
        if (usage.limitExceeded) {
             console.log(`[${this.guildId}] 上限超過のため拒否`);
             return; 
        }

        // 4. カウント加算
        addCharacterUsage(this.guildId, cost); 
        
        // 5. VOICEVOX閾値超えの通知
        if (!useOjt && VVX_CHAR_THRESHOLD > 0 && usage.count < VVX_CHAR_THRESHOLD && (usage.count + cost) >= VVX_CHAR_THRESHOLD) {
             this._notifyOjtSwitch(VVX_CHAR_THRESHOLD); 
        }

        // キューに追加 (forcedOjtフラグを渡す)
        this.messageQueue.push({ text, userId, forcedOjt: isForcedOjt });
        if (!this.isPlaying) { this._playNextMessage(); }
    }
    
    _notifyOjtSwitch(threshold) {
         if (!this.currentTextChannelId) return;
         const ch = this.client.channels.cache.get(this.currentTextChannelId);
         if (ch) ch.send(`**⚠️ お知らせ**\nVOICEVOX読み上げ文字数閾値 (${threshold.toLocaleString()}文字) に到達しました。\nこれ以降はOpen JTalkでの読み上げに切り替わります。`).catch(()=>{});
    }

    // --- ActiveSpeech制御 ---
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
                if (ch) ch.messages.delete(this.warningMessageId).catch(() => {});
            } catch(e) {}
            this.warningMessageId = null;
        }
        this.activeSpeechTimeoutCount = 0;
    }

    // --- 待機判定ロジック ---
    _shouldWaitForActiveSpeech() {
        if (this.forcePlayOneTime) return false;
        if (this.speakingUsers.size === 0) return false;

        // ActiveSpeechがサーバー設定になったため、ここも修正が必要
        const guildSettings = getGuildSettings(this.guildId);
        if (!guildSettings.active_speech) return false;
        
        // サーバー設定の場合、誰かが喋っていれば待機
        return true; 
    }

    // --- 再生処理 ---
    async _playNextMessage() {
        if (this.playTimer) {
            clearTimeout(this.playTimer);
            this.playTimer = null;
        }

        if (this.messageQueue.length === 0 || !this.isActive()) {
            this.isPlaying = false; 
            return;
        }

        // ActiveSpeechチェック
        if (this._shouldWaitForActiveSpeech()) {
            this.activeSpeechTimeoutCount++;
            if (this.activeSpeechTimeoutCount === 20 && !this.warningMessageId) {
                this._sendActiveSpeechWarning();
            }
            this.playTimer = setTimeout(() => this._playNextMessage(), 500); 
            return;
        }

        this.forcePlayOneTime = false; 
        this._cleanupWarningMessage();

        if (!this.connection || this.connection.state.status !== VoiceConnectionStatus.Ready) {
            try {
                if (this.connection) await entersState(this.connection, VoiceConnectionStatus.Ready, 1000); 
                else throw new Error("Connection is null");
            } catch (e){
                 this.isPlaying = false;
                 this.playTimer = setTimeout(() => this._playNextMessage(), 500);
                 return;
            }
        }
        
        this.isPlaying = true;
        const item = this.messageQueue.shift();
        
        // ★ リクエスト数をカウント
        const userSettings = this.getSettingsForUser(item.userId);
        const useOjt = item.forcedOjt || (userSettings.speakerType === 'ojt');
        incrementRequest(useOjt); 

        // サービスを使用して音声を生成
        const resource = await synthesize(item.text, {
            userId: item.userId,
            guildId: this.guildId,
            client: this.client,
            useOjt: useOjt,
            speakerId: userSettings.speakerId,
            speed: userSettings.speed,
            pitch: userSettings.pitch
        });

        if (resource) {
            this.audioPlayer.play(resource);
        } else {
            this.isPlaying = false;
            this._playNextMessage();
        }
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
                        // ★ サーバー設定に移動したため、無効化ボタンは一時的に削除または修正が必要だが、
                        // 以前のロジックをベースにしているため、一旦ボタンのみ削除（機能はそのまま）
                    );
                const msg = await ch.send({
                    content: '⏳ **ActiveSpeech 待機中**\n会話が続いているため、読み上げを10秒以上待機しています。',
                    components: [row]
                });
                this.warningMessageId = msg.id;
            }
        } catch (e) { console.error(`[${this.guildId}] Warning送信失敗:`, e.message); }
    }
}

module.exports = { VoiceConnectionManager };