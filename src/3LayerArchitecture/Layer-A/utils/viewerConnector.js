/**
 * ViewerConnector - UX System Viewer への接続を管理するクラス
 * TTS Bot の統計情報を Viewer Server に送信する
 */

const WebSocket = require('ws');

class ViewerConnector {
    constructor(serverUrl) {
        this.serverUrl = serverUrl;
        this.ws = null;
        this.reconnectInterval = 5000;
        this.isConnecting = false;
    }

    /**
     * サーバーへの接続を開始
     */
    connect() {
        if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
            return;
        }

        this.isConnecting = true;
        console.log(`[ViewerConnector] Connecting to ${this.serverUrl}...`);

        try {
            this.ws = new WebSocket(this.serverUrl);

            this.ws.on('open', () => {
                this.isConnecting = false;
                console.log('[ViewerConnector] Connected to Viewer Server');
            });

            this.ws.on('close', () => {
                this.isConnecting = false;
                console.log('[ViewerConnector] Disconnected from Viewer Server. Reconnecting...');
                setTimeout(() => this.connect(), this.reconnectInterval);
            });

            this.ws.on('error', (err) => {
                this.isConnecting = false;
                console.error('[ViewerConnector] WebSocket error:', err.message);
                // close イベントが発火するので、ここでは再接続しない
            });

            this.ws.on('message', (data) => {
                try {
                    const message = JSON.parse(data);
                    if (message.type === 'viewer_status') {
                        // ビューワー数を受信（ログ用）
                        console.log(`[ViewerConnector] Viewer count: ${message.payload.count}`);
                    }
                } catch (e) {
                    // パースエラーは無視
                }
            });
        } catch (err) {
            this.isConnecting = false;
            console.error('[ViewerConnector] Connection error:', err.message);
            setTimeout(() => this.connect(), this.reconnectInterval);
        }
    }

    /**
     * TTS 統計情報を送信
     * @param {Object} stats - 送信する統計情報
     */
    sendStats(stats) {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return false;
        }

        try {
            const message = JSON.stringify({
                type: 'tts_update',
                payload: stats
            });
            this.ws.send(message);
            return true;
        } catch (err) {
            console.error('[ViewerConnector] Failed to send stats:', err.message);
            return false;
        }
    }

    /**
     * 接続を閉じる
     */
    close() {
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
    }
}

module.exports = ViewerConnector;
