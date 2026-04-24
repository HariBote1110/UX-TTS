/**
 * ワーカー設定管理モジュール
 * 各ワーカーの重み（選択確率）と容量（保持できるキャラクター数）を管理
 */

class WorkerConfig {
    constructor() {
        this.config = new Map(); // { url: { weight, capacity } }
        this.loadConfig();
    }

    /**
     * 環境変数からワーカー設定を読み込む
     * 形式: WORKER_CONFIG={"url":{"weight":1.5,"capacity":10},...}
     */
    loadConfig() {
        const configStr = process.env.WORKER_CONFIG;

        if (configStr) {
            try {
                const parsed = JSON.parse(configStr);
                for (const [url, settings] of Object.entries(parsed)) {
                    this.config.set(url, {
                        weight: settings.weight || 1.0,
                        capacity: settings.capacity || Infinity
                    });
                }
                console.log(`[WorkerConfig] Loaded config for ${this.config.size} workers.`);
            } catch (e) {
                console.error('[WorkerConfig] Failed to parse WORKER_CONFIG:', e.message);
            }
        } else {
            console.log('[WorkerConfig] No WORKER_CONFIG found. Using defaults.');
        }
    }

    /**
     * ワーカーの重みを取得
     * @param {string} url ワーカーURL
     * @returns {number} 重み（デフォルト: 1.0）
     */
    getWeight(url) {
        const cfg = this.config.get(url);
        return cfg ? cfg.weight : 1.0;
    }

    /**
     * ワーカーの容量を取得
     * @param {string} url ワーカーURL
     * @returns {number} 容量（デフォルト: Infinity）
     */
    getCapacity(url) {
        const cfg = this.config.get(url);
        return cfg ? cfg.capacity : Infinity;
    }

    /**
     * 設定済みの全ワーカー設定を取得
     * @returns {object[]}
     */
    getAllConfigs() {
        const result = [];
        for (const [url, cfg] of this.config) {
            result.push({ url, ...cfg });
        }
        return result;
    }

    /**
     * 設定のリロード
     */
    reload() {
        this.config.clear();
        this.loadConfig();
    }
}

const workerConfigSingleton = new WorkerConfig();
module.exports = workerConfigSingleton;
module.exports.WorkerConfig = WorkerConfig;
