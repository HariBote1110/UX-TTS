const fs = require('fs');
const path = require('path');

// 統計データを保持するオブジェクト
let stats = {
    totalRequests: 0,
    voicevoxRequests: 0,
    ojtRequests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    startTime: Date.now()
};

// レポート出力先 (report.jsと同じ reports/ フォルダ)
const reportDir = path.join(__dirname, '../../reports');
if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });

// response.csv のパス
const responseCsvFile = path.join(reportDir, 'response.csv');

module.exports = {
    incrementRequest: (isOjt) => {
        stats.totalRequests++;
        if (isOjt) {
            stats.ojtRequests++;
        } else {
            stats.voicevoxRequests++;
        }
    },

    incrementCache: (isHit) => {
        if (isHit) {
            stats.cacheHits++;
        } else {
            stats.cacheMisses++;
        }
    },

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
    },

    // レイテンシ記録機能
    recordLatency: (guildId, latencyMs, source, textLength) => {
        const now = new Date().toISOString();
        // フォーマット: 日時, サーバーID, レイテンシ(ms), ソース(Generate/Cache/Preload), 文字数
        const line = `${now},${guildId},${latencyMs},${source},${textLength}\n`;
        
        try {
            fs.appendFileSync(responseCsvFile, line);
        } catch (e) {
            console.error('Failed to write response.csv:', e.message);
        }
    },

    // 指定された時間(hours)の平均レイテンシを取得
    // デフォルトは24時間
    getAverageLatencyStats: (hours = 24) => {
        try {
            if (!fs.existsSync(responseCsvFile)) return { avg: 0, count: 0, min: 0, max: 0 };

            const data = fs.readFileSync(responseCsvFile, 'utf8');
            const lines = data.trim().split('\n');
            
            const now = Date.now();
            const timeWindowMs = hours * 60 * 60 * 1000;
            
            const validLatencies = [];
            
            for (const line of lines) {
                if (!line.trim()) continue;
                const parts = line.split(',');
                if (parts.length < 3) continue;

                const timestamp = new Date(parts[0]).getTime();
                const latency = parseFloat(parts[2]);

                // 指定期間以内 かつ 有効な数値のみ集計
                if (now - timestamp < timeWindowMs && !isNaN(latency)) {
                    validLatencies.push(latency);
                }
            }

            if (validLatencies.length === 0) return { avg: 0, count: 0, min: 0, max: 0 };

            const sum = validLatencies.reduce((a, b) => a + b, 0);
            const avg = sum / validLatencies.length;
            const min = Math.min(...validLatencies);
            const max = Math.max(...validLatencies);

            return {
                avg: Math.round(avg),
                count: validLatencies.length,
                min: Math.round(min),
                max: Math.round(max)
            };

        } catch (e) {
            console.error('Stats Calc Error:', e);
            return { avg: 0, count: 0, min: 0, max: 0 };
        }
    }
};