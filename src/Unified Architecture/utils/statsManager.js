// 統計データを保持するオブジェクト
let stats = {
    totalRequests: 0,
    voicevoxRequests: 0,
    ojtRequests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    startTime: Date.now()
};

module.exports = {
    /**
     * リクエスト数をカウントアップ
     * @param {boolean} isOjt Open JTalkかどうか
     */
    incrementRequest: (isOjt) => {
        stats.totalRequests++;
        if (isOjt) {
            stats.ojtRequests++;
        } else {
            stats.voicevoxRequests++;
        }
    },

    /**
     * キャッシュヒット/ミスをカウントアップ
     * @param {boolean} isHit ヒットしたかどうか
     */
    incrementCache: (isHit) => {
        if (isHit) {
            stats.cacheHits++;
        } else {
            stats.cacheMisses++;
        }
    },

    /**
     * 現在の統計を取得し、カウンターをリセットする
     * @returns {object} 集計結果
     */
    getAndResetStats: () => {
        const now = Date.now();
        const result = {
            ...stats,
            endTime: now,
            durationMs: now - stats.startTime
        };

        // リセット
        stats = {
            totalRequests: 0,
            voicevoxRequests: 0,
            ojtRequests: 0,
            cacheHits: 0,
            cacheMisses: 0,
            startTime: now
        };

        return result;
    }
};