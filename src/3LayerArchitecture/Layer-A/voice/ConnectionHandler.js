const { 
    joinVoiceChannel, 
    getVoiceConnection,
    VoiceConnectionStatus,
    entersState
} = require('@discordjs/voice');
const EventEmitter = require('events');
const { sendErrorLog } = require('../errorLogger');

/**
 * VC接続管理クラス (Classic Stable Edition)
 * 安定動作する uxtts-slim バージョンのロジックをベースに、
 * 余計な制御を排除し、ライブラリ標準の挙動に完全に準拠させた版。
 */
class ConnectionHandler extends EventEmitter {
    constructor(client, guildId) {
        super();
        this.client = client;
        this.guildId = guildId;
        this.connection = null;
        this.currentVoiceChannel = null;
        this.isIntentionalDisconnect = false;
    }

    /**
     * VC接続
     * uxtts-slimのロジックに準拠:
     * 1. 既存接続があれば即destroy
     * 2. シンプルにjoinVoiceChannel
     * 3. 30秒待機
     */
    async connect(channel) {
        if (!channel) return false;

        // 既に同じボイスチャンネルにいて、Ready状態なら何もしないで成功とする
        // (uxtts-slimではVoiceManager側で判定していましたが、念のためここでもチェック)
        if (this.connection && 
            this.connection.state.status === VoiceConnectionStatus.Ready && 
            this.currentVoiceChannel && 
            this.currentVoiceChannel.id === channel.id) {
            console.log(`[${this.guildId}] [ConnectionHandler] 既存接続を維持します: ${channel.name}`);
            return true;
        }

        console.log(`[${this.guildId}] [ConnectionHandler] 接続開始: ${channel.name}`);

        // ★重要: 既存の接続があるなら、問答無用で破壊してリセットする
        // (状態チェックなどをせず、とにかく新しく作り直すのが最も安定します)
        if (this.connection) {
            try { this.connection.destroy(); } catch (e) {}
            this.connection = null;
        }
        // ライブラリ管理外の幽霊接続も念のためチェック
        const existingLibConn = getVoiceConnection(this.guildId);
        if (existingLibConn) {
            try { existingLibConn.destroy(); } catch (e) {}
        }

        // 少しだけインターバルを置く（破壊処理の伝播待ち）
        await new Promise(r => setTimeout(r, 500));

        this.currentVoiceChannel = channel;
        this.isIntentionalDisconnect = false;

        try {
            // 新規接続
            this.connection = joinVoiceChannel({
                channelId: channel.id,
                guildId: this.guildId,
                adapterCreator: channel.guild.voiceAdapterCreator,
                selfDeaf: true,
                group: 'default'
            });

            // ステータスログ
            this.connection.on('stateChange', (oldState, newState) => {
                console.log(`[${this.guildId}] [State] ${oldState.status} -> ${newState.status}`);
            });

            // ★重要: タイムアウトをslim版と同じ30秒に設定
            await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000);
            
            console.log(`[${this.guildId}] [ConnectionHandler] 接続完了`);
            this._setupListeners();
            return true;

        } catch (error) {
            console.error(`[${this.guildId}] [ConnectionHandler] 接続失敗:`, error.message);
            
            // 失敗したら後始末
            if (this.connection) {
                try { this.connection.destroy(); } catch(e){}
                this.connection = null;
            }
            
            if (error.name !== 'AbortError') {
                sendErrorLog(this.client, error, { place: 'ConnectionHandler.connect', guildId: this.guildId });
            }
            return false;
        }
    }

    /**
     * VC切断
     * uxtts-slimのロジックに準拠:
     * 余計なパケット送信などはせず、connection.destroy() のみを行う
     */
    disconnect(isAutoDisconnect = false) {
        console.log(`[${this.guildId}] [ConnectionHandler] 切断リクエスト`);
        this.isIntentionalDisconnect = !isAutoDisconnect;

        // ライブラリ標準の切断
        // (自分のthis.connectionだけでなく、getVoiceConnectionで確実に取得して消す)
        const connection = getVoiceConnection(this.guildId);
        if (connection) {
            try {
                connection.destroy();
                console.log(`[${this.guildId}] [ConnectionHandler] destroy() 実行完了`);
            } catch (e) {
                console.error(`[${this.guildId}] Destroy Error:`, e.message);
            }
        } else {
            // 接続がない場合でも、UI更新のためにイベントは飛ばす
            this._handleDestroyed();
        }
    }

    // --- 内部リスナー ---
    
    _setupListeners() {
        if (!this.connection) return;

        // リスナー重複防止
        this.connection.removeAllListeners(VoiceConnectionStatus.Disconnected);
        this.connection.removeAllListeners(VoiceConnectionStatus.Destroyed);

        // 1. 切断 (ネットワーク切断やサーバー移動など)
        this.connection.on(VoiceConnectionStatus.Disconnected, async () => {
            console.log(`[${this.guildId}] [Event] Disconnected (Network/Server Move)`);
            try {
                await Promise.race([
                    entersState(this.connection, VoiceConnectionStatus.Signalling, 5_000),
                    entersState(this.connection, VoiceConnectionStatus.Connecting, 5_000),
                ]);
                console.log(`[${this.guildId}] [Event] 再接続成功`);
            } catch (error) {
                console.log(`[${this.guildId}] [Event] 復帰失敗 -> 破棄します`);
                if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
                    this.connection.destroy();
                } else {
                    this._handleDestroyed();
                }
            }
        });

        // 2. 破棄 (手動切断完了)
        this.connection.on(VoiceConnectionStatus.Destroyed, () => {
            console.log(`[${this.guildId}] [Event] Destroyed`);
            this._handleDestroyed();
        });

        // Speakingイベント
        if (this.connection.receiver) {
            this.connection.receiver.speaking.on('start', (userId) => {
                this.emit('speakingStateChange', userId, true);
            });
            this.connection.receiver.speaking.on('end', (userId) => {
                this.emit('speakingStateChange', userId, false);
            });
        }
    }

    _handleDestroyed() {
        // 重複実行防止のため、connectionがnullなら何もしないガードを入れてもいいが、
        // slim版はシンプルなのでそのまま実行する
        const isAuto = !this.isIntentionalDisconnect;
        
        // ステートリセット
        this.connection = null;
        this.currentVoiceChannel = null;
        this.isIntentionalDisconnect = false;

        this.emit('destroyed', isAuto);
    }

    // 外部ヘルパー
    setSelfDeaf(isDeaf) {
        if (!this.isActive() || !this.currentVoiceChannel) return;
        try {
            joinVoiceChannel({
                channelId: this.currentVoiceChannel.id,
                guildId: this.guildId,
                adapterCreator: this.currentVoiceChannel.guild.voiceAdapterCreator,
                selfDeaf: isDeaf, 
            });
        } catch (e) { console.error(e); }
    }

    isActive() { 
        return this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed; 
    }
    getConnection() { return this.connection; }
    getVoiceChannel() { return this.currentVoiceChannel; }
}

module.exports = { ConnectionHandler };