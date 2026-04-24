/**
 * Bot全体でVC接続リクエストを直列化（順番待ち）するためのキュー
 * 同時にGatewayへ接続要求を送るとパケットロスやレート制限の原因になるため。
 */
class ConnectionQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
    }

    /**
     * 処理をキューに追加して実行
     * @param {Function} task - 実行する非同期関数
     * @returns {Promise<any>}
     */
    add(task) {
        return new Promise((resolve, reject) => {
            this.queue.push({ task, resolve, reject });
            this._process();
        });
    }

    async _process() {
        if (this.processing) return;
        if (this.queue.length === 0) return;

        this.processing = true;
        const { task, resolve, reject } = this.queue.shift();

        try {
            const result = await task();
            resolve(result);
        } catch (error) {
            reject(error);
        } finally {
            // 次の処理まで少しクールダウンを入れる（Gatewayの負担軽減）
            await new Promise(r => setTimeout(r, 500));
            this.processing = false;
            this._process();
        }
    }
}

// シングルトンとしてエクスポート
module.exports = new ConnectionQueue();