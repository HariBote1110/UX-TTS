const axios = require('axios');
const workerConfig = require('./workerConfig');

/**
 * Layer-C Worker (TTSエンジン) の負荷分散とヘルスチェックを行うクラス
 */
class EngineSelector {
    constructor() {
        // 統計データ: { url: { totalMs, totalChars, count } }
        this.stats = new Map();
        // ダウン中のワーカー: Map<url, failedAt>
        this.downWorkers = new Map();
        // ワーカー割り当て: Map<url, Set<speakerId>> - 各ワーカーが担当しているキャラクターを追跡
        this.workerAssignments = new Map();
        // 実行中のリクエスト数: Map<url, number>
        this.activeRequests = new Map();

        // 初回読み込み
        this.loadEngines();

        // 定期的にダウンしたワーカーの生存確認を行う (30秒ごと)
        this.healthCheckInterval = setInterval(() => this.checkHealth(), 30000);
    }

    /**
     * 環境変数からエンジンリストを読み込む
     */
    loadEngines() {
        // 環境変数 TTS_WORKER_URLS (カンマ区切り) を優先、なければ TTS_WORKER_URL を使用
        const urlsEnv = process.env.TTS_WORKER_URLS || process.env.TTS_WORKER_URL || '';
        this.engines = urlsEnv.split(',').map(url => url.trim()).filter(url => url.length > 0);

        console.log(`[EngineSelector] Loaded ${this.engines.length} workers:`, this.engines);
    }

    /**
     * リロード用
     */
    reload() {
        this.loadEngines();
        // 存在しないURLの統計情報を削除
        for (const url of this.stats.keys()) {
            if (!this.engines.includes(url)) this.stats.delete(url);
        }
        for (const url of this.downWorkers.keys()) {
            if (!this.engines.includes(url)) this.downWorkers.delete(url);
        }
    }

    /**
     * 利用可能な（ダウンしていない）全ワーカーのリストを返す
     */
    getAvailableWorkers() {
        return this.engines.filter(url => !this.downWorkers.has(url));
    }

    /**
     * ★追加: 全ワーカーの統計情報を取得する (レポート用)
     */
    getWorkerStats() {
        return this.engines.map(url => {
            const stat = this.stats.get(url) || { totalMs: 0, totalChars: 0, count: 0 };
            const isDown = this.downWorkers.has(url);

            // 平均速度 (ms/char)
            const avgSpeed = stat.totalChars > 0 ? (stat.totalMs / stat.totalChars).toFixed(2) : '-';
            // 平均応答時間 (ms/req)
            const avgLatency = stat.count > 0 ? Math.round(stat.totalMs / stat.count) : '-';

            return {
                url,
                isDown,
                count: stat.count,
                avgSpeed,
                avgLatency
            };
        });
    }

    /**
     * 最適なWorkerのURLを選択して返す
     * @param {string[]} excludeUrls 一時的に除外するURLリスト
     * @param {number|string} speakerId キャラクターID（ルーティングの判断に使用）
     */
    select(excludeUrls = [], speakerId = null) {
        // 生きている、かつ除外リストに含まれていないワーカーを抽出
        const availableEngines = this.engines.filter(url =>
            !this.downWorkers.has(url) && !excludeUrls.includes(url)
        );

        // 全滅(または除外ですべて無くなった)場合
        if (availableEngines.length === 0) {
            // ダウンリストも含めて、除外リストに入っていないものから無理やり選ぶ
            const fallbackEngines = this.engines.filter(url => !excludeUrls.includes(url));
            if (fallbackEngines.length > 0) {
                console.warn('[EngineSelector] ⚠️ All workers seem down. Trying fallback from down-list.');
                return fallbackEngines[Math.floor(Math.random() * fallbackEngines.length)];
            }
            return null; // どうしようもない
        }

        if (availableEngines.length === 1) {
            this._assignCharacterToWorker(availableEngines[0], speakerId);
            return availableEngines[0];
        }

        // ★★★ キャラクターベースのルーティングロジック ★★★
        if (speakerId !== null && speakerId !== undefined) {
            const characterStats = require('./characterStats');
            const isHighUsage = characterStats.isHighUsage(speakerId);

            // 重みづけでソートされた利用可能なワーカーリストを取得
            const sortedByWeight = this._sortByWeightAndSpeed(availableEngines);

            if (isHighUsage) {
                // 高頻度キャラクター: 重み・速度優先で選択（容量チェック付き）
                const selected = this._selectWithCapacityCheck(sortedByWeight, speakerId);
                console.log(`[EngineSelector] 🎯 High-usage character (${speakerId}) → Main worker: ${selected}`);
                this._assignCharacterToWorker(selected, speakerId);
                return selected;
            } else {
                // 低頻度キャラクター: 2番目以降のワーカーを優先して、メインワーカーの負荷を下げる
                // ただし容量に余裕があるワーカーを選択
                const selected = this._selectSecondaryWithCapacityCheck(sortedByWeight, speakerId);
                console.log(`[EngineSelector] 🔄 Low-usage character (${speakerId}) → Secondary worker: ${selected}`);
                this._assignCharacterToWorker(selected, speakerId);
                return selected;
            }
        }

        // speakerIdが指定されていない場合は従来のロジック（統計データに基づく選択）
        // 1. まだ統計データがない（未使用の）ワーカーを優先
        const unknownEngines = availableEngines.filter(url => !this.stats.has(url));
        if (unknownEngines.length > 0) {
            return unknownEngines[Math.floor(Math.random() * unknownEngines.length)];
        }

        // 2. 実行中リクエストが少なく、かつ文字あたりの生成速度 (ms / char) が速い順にソートして選択
        const sorted = [...availableEngines].sort((a, b) => {
            const activeA = this.activeRequests.get(a) || 0;
            const activeB = this.activeRequests.get(b) || 0;

            if (activeA !== activeB) {
                return activeA - activeB; // リクエストが少ない方を優先
            }

            const statA = this.stats.get(a) || { totalMs: 0, totalChars: 0 };
            const statB = this.stats.get(b) || { totalMs: 0, totalChars: 0 };

            const speedA = statA.totalChars > 0 ? (statA.totalMs / statA.totalChars) : Infinity;
            const speedB = statB.totalChars > 0 ? (statB.totalMs / statB.totalChars) : Infinity;

            return speedA - speedB;
        });

        const selected = sorted[0];
        this._assignCharacterToWorker(selected, speakerId);
        return selected;
    }

    /**
     * 重み、速度、および現在の負荷を考慮してワーカーをソート
     * @param {string[]} engines 利用可能なワーカーリスト
     * @returns {string[]} ソートされたワーカーリスト
     */
    _sortByWeightAndSpeed(engines) {
        return [...engines].sort((a, b) => {
            // 現在の負荷（低いほど優先）
            const activeA = this.activeRequests.get(a) || 0;
            const activeB = this.activeRequests.get(b) || 0;

            if (activeA !== activeB) {
                return activeA - activeB;
            }

            // 重み（高いほど優先）
            const weightA = workerConfig.getWeight(a);
            const weightB = workerConfig.getWeight(b);

            // 速度（低いほど速い）
            const statA = this.stats.get(a) || { totalMs: 0, totalChars: 1 };
            const statB = this.stats.get(b) || { totalMs: 0, totalChars: 1 };
            const speedA = statA.totalChars > 0 ? (statA.totalMs / statA.totalChars) : 100;
            const speedB = statB.totalChars > 0 ? (statB.totalMs / statB.totalChars) : 100;

            // スコア計算: 重みが高く、速度が速いほど高スコア
            const scoreA = weightA * (1 / (speedA + 1));
            const scoreB = weightB * (1 / (speedB + 1));

            return scoreB - scoreA; // 降順（高スコアが先頭）
        });
    }

    /**
     * 容量チェック付きでワーカーを選択（高頻度キャラクター用）
     */
    _selectWithCapacityCheck(sortedEngines, speakerId) {
        for (const url of sortedEngines) {
            if (this._hasCapacity(url, speakerId)) {
                return url;
            }
        }
        // 容量に空きがない場合はトップのワーカーを返す
        return sortedEngines[0];
    }

    /**
     * 2番目以降のワーカーを優先して選択（低頻度キャラクター用）
     */
    _selectSecondaryWithCapacityCheck(sortedEngines, speakerId) {
        // まず2番目以降で容量に空きがあるワーカーを探す
        for (let i = 1; i < sortedEngines.length; i++) {
            if (this._hasCapacity(sortedEngines[i], speakerId)) {
                return sortedEngines[i];
            }
        }
        // なければ1番目を含めて探す
        return this._selectWithCapacityCheck(sortedEngines, speakerId);
    }

    /**
     * ワーカーに容量の余裕があるかチェック
     */
    _hasCapacity(url, speakerId) {
        const capacity = workerConfig.getCapacity(url);
        if (capacity === Infinity) return true;

        const assignments = this.workerAssignments.get(url) || new Set();
        // 既に割り当て済みのキャラクターなら容量を消費しない
        if (speakerId && assignments.has(parseInt(speakerId, 10))) {
            return true;
        }
        return assignments.size < capacity;
    }

    /**
     * キャラクターをワーカーに割り当て
     */
    _assignCharacterToWorker(url, speakerId) {
        if (!speakerId) return;

        if (!this.workerAssignments.has(url)) {
            this.workerAssignments.set(url, new Set());
        }
        this.workerAssignments.get(url).add(parseInt(speakerId, 10));
    }

    /**
     * 特定ワーカーに割り当てられたキャラクターIDリストを取得
     * @param {string} url ワーカーURL
     * @returns {number[]} キャラクターIDリスト
     */
    getWorkerCharacters(url) {
        const assignments = this.workerAssignments.get(url);
        if (!assignments) return [];
        return [...assignments];
    }

    /**
     * 全ワーカーの割り当て状況を取得（API用）
     */
    getRoutingStats() {
        return this.engines.map(url => {
            const assignments = this.workerAssignments.get(url) || new Set();
            return {
                url,
                weight: workerConfig.getWeight(url),
                capacity: workerConfig.getCapacity(url),
                activeRequests: this.activeRequests.get(url) || 0,
                assignedCount: assignments.size,
                assignedCharacters: [...assignments],
                isDown: this.downWorkers.has(url)
            };
        });
    }

    /**
     * リクエスト開始を記録
     */
    startRequest(url) {
        if (!url) return;
        const current = this.activeRequests.get(url) || 0;
        this.activeRequests.set(url, current + 1);
    }

    /**
     * リクエスト終了を記録
     */
    endRequest(url) {
        if (!url) return;
        const current = this.activeRequests.get(url) || 0;
        this.activeRequests.set(url, Math.max(0, current - 1));
    }

    /**
     * 生成成功を記録する
     */
    record(url, timeMs, charCount) {
        if (!url || !this.engines.includes(url)) return;

        if (this.downWorkers.has(url)) {
            console.log(`[EngineSelector] ✅ Worker revived (Success record): ${url}`);
            this.downWorkers.delete(url);
        }

        if (!this.stats.has(url)) {
            this.stats.set(url, { totalMs: 0, totalChars: 0, count: 0 });
        }

        const s = this.stats.get(url);
        s.totalMs += timeMs;
        s.totalChars += charCount;
        s.count += 1;
    }

    /**
     * 生成失敗を報告する
     */
    reportFailure(url) {
        if (!url || !this.engines.includes(url)) return;

        if (!this.downWorkers.has(url)) {
            console.warn(`[EngineSelector] 🚨 Worker marked as DOWN: ${url}`);
            this.downWorkers.set(url, Date.now());
        }
    }

    /**
     * ヘルスチェック
     */
    async checkHealth() {
        if (this.downWorkers.size === 0) return;

        console.log(`[EngineSelector] 🏥 Running health check for ${this.downWorkers.size} workers...`);

        for (const [url, failedAt] of this.downWorkers) {
            try {
                // Layer-C の /version エンドポイントで確認
                await axios.get(`${url}/version`, { timeout: 3000 });

                console.log(`[EngineSelector] 🎉 Worker recovered (Health check passed): ${url}`);
                this.downWorkers.delete(url);
            } catch (e) {
                const reason = e.code || e.message;
                const status = e.response ? e.response.status : 'No Response';
                console.warn(`[EngineSelector] ⚠️ Worker check failed: ${url} (Reason: ${reason}, Status: ${status})`);
            }
        }
    }
}

module.exports = new EngineSelector();