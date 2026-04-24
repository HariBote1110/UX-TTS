const { createAudioPlayer, AudioPlayerStatus } = require('@discordjs/voice');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { synthesize } = require('../services/synthesizer'); 
const { sendErrorLog } = require('../errorLogger');
const { incrementRequest } = require('../utils/statsManager');
const { getGuildSettings } = require('../database');

/**
 * 音声再生・キュー管理・ActiveSpeech待機ロジックを担当するクラス
 * ★デバッグログ強化版
 */
class AudioPlayerHandler {
    constructor(client, guildId) {
        this.client = client;
        this.guildId = guildId;
        this.audioPlayer = createAudioPlayer();
        
        this.messageQueue = []; 
        this.isPlaying = false;
        
        // ActiveSpeech用
        this.speakingUsers = new Set();
        this.activeSpeechTimeoutCount = 0; 
        this.warningMessageId = null;      
        this.playTimer = null;             
        this.forcePlayOneTime = false;
        
        // 現在のテキストチャンネルID (Botがメッセージを送る場所)
        this.currentTextChannelId = null;

        this._setupPlayerListeners();
    }

    setTextChannelId(id) {
        this.currentTextChannelId = id;
    }

    // 接続確立時にConnectionをPlayerに紐付ける
    subscribeTo(connection) {
        if (connection) {
            console.log(`[${this.guildId}] [AudioPlayerHandler] Subscribing player to connection.`);
            connection.subscribe(this.audioPlayer);
        }
    }

    // キュー追加
    addQueueItem(item) {
        // console.log(`[${this.guildId}] [AudioPlayerHandler] Adding to queue. Text: "${item.text.substring(0, 10)}..."`);
        this.messageQueue.push(item);
        if (!this.isPlaying) {
            this._playNextMessage();
        }
    }

    // 停止・クリア
    stop() {
        console.log(`[${this.guildId}] [AudioPlayerHandler] Stop requested.`);
        this.audioPlayer.stop(true);
        this.messageQueue = [];
        this.isPlaying = false;
        this.speakingUsers.clear();
        this._cleanupWarningMessage();
        if (this.playTimer) clearTimeout(this.playTimer);
    }

    // ActiveSpeech: 発話状態の更新
    handleSpeakingState(userId, isSpeaking) {
        if (isSpeaking) {
            // console.log(`[${this.guildId}] [AudioPlayerHandler] User ${userId} started speaking.`);
            this.speakingUsers.add(userId);
        } else {
            // console.log(`[${this.guildId}] [AudioPlayerHandler] User ${userId} stopped speaking.`);
            this.speakingUsers.delete(userId);
        }
    }

    // ActiveSpeech: 制御コマンド
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

    // --- 内部ロジック ---

    _setupPlayerListeners() {
        this.audioPlayer.on(AudioPlayerStatus.Idle, () => {
            // console.log(`[${this.guildId}] [AudioPlayerHandler] Player Idle.`);
            this.isPlaying = false;
            this._playNextMessage(); 
        });
        this.audioPlayer.on(AudioPlayerStatus.Playing, () => {
             // console.log(`[${this.guildId}] [AudioPlayerHandler] Player Playing.`);
        });
        this.audioPlayer.on('error', error => {
            console.error(`[${this.guildId}] [AudioPlayerHandler] AudioPlayerエラー: ${error.message}`);
            sendErrorLog(this.client, error, { place: 'AudioPlayer Error', guildId: this.guildId });
            this.isPlaying = false;
            this._playNextMessage(); 
        });
    }

    _cleanupWarningMessage() {
        if (this.warningMessageId && this.currentTextChannelId) {
            try {
                const ch = this.client.channels.cache.get(this.currentTextChannelId);
                if (ch) ch.messages.delete(this.warningMessageId).catch((err) => {
                    if (err.code !== 10008) {
                        console.error(`[${this.guildId}] [AudioPlayerHandler] Warning message delete error:`, err);
                    }
                });
            } catch(e) {
                console.error(`[${this.guildId}] [AudioPlayerHandler] _cleanupWarningMessage sync error:`, e);
            }
            this.warningMessageId = null;
        }
        this.activeSpeechTimeoutCount = 0;
    }

    _shouldWaitForActiveSpeech() {
        if (this.forcePlayOneTime) return false;
        if (this.speakingUsers.size === 0) return false;

        const guildSettings = getGuildSettings(this.guildId);
        return !!guildSettings.active_speech; 
    }

    async _playNextMessage() {
        if (this.playTimer) {
            clearTimeout(this.playTimer);
            this.playTimer = null;
        }

        if (this.messageQueue.length === 0) {
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
        
        this.isPlaying = true;
        const item = this.messageQueue.shift();
        
        // 統計更新
        incrementRequest(item.useOjt); 

        // 音声生成
        try {
            const resource = await synthesize(item.text, {
                userId: item.userId,
                guildId: this.guildId,
                client: this.client,
                useOjt: item.useOjt,
                speakerId: item.settings.speakerId,
                speed: item.settings.speed,
                pitch: item.settings.pitch
            });

            if (resource) {
                this.audioPlayer.play(resource);
            } else {
                this.isPlaying = false;
                this._playNextMessage();
            }
        } catch (e) {
            console.error(`[${this.guildId}] [AudioPlayerHandler] Synthesize Error:`, e);
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
        } catch (e) { console.error(`[${this.guildId}] Warning送信失敗:`, e.message); }
    }
}

module.exports = { AudioPlayerHandler };
