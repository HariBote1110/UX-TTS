process.env.UV_THREADPOOL_SIZE = 128; // デフォルト4 -> 128に拡張

require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Collection, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const dns = require('node:dns');
const { sendErrorLog } = require('./errorLogger');
const { getAndResetStats, getAverageLatencyStats } = require('./utils/statsManager');
const { updateActivity } = require('./utils/helpers');
const { releaseVoiceChannelClaimsByOwner } = require('./database');
// ★追加: エンジンセレクターをインポート
const engineSelector = require('./utils/engineSelector');
// ★追加: ViewerConnector をインポート
const ViewerConnector = require('./utils/viewerConnector');

const { DISCORD_BOT_TOKEN } = process.env;
const currentShardId = Number.parseInt(process.env.SHARDS ?? '', 10);
const isShardedProcess = Number.isInteger(currentShardId);
const parsedMaintenanceShardId = Number.parseInt(process.env.MAINTENANCE_SHARD_ID ?? '0', 10);
const maintenanceShardId = Number.isInteger(parsedMaintenanceShardId) ? parsedMaintenanceShardId : 0;
const isMaintenanceShard = !isShardedProcess || currentShardId === maintenanceShardId;
const shardPrefix = isShardedProcess ? `[Shard ${currentShardId}]` : '[Single]';

try {
    dns.setDefaultResultOrder('ipv4first');
} catch (error) {
    console.warn(`${shardPrefix} [System] DNS解決順序の設定に失敗しました: ${error.message}`);
}

const parseBoolean = (value, fallback = false) => {
    if (value == null || value === '') return fallback;
    const lowered = String(value).toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(lowered)) return true;
    if (['0', 'false', 'no', 'off'].includes(lowered)) return false;
    return fallback;
};

const enableLayerADashboard = parseBoolean(process.env.ENABLE_LAYER_A_DASHBOARD, false);

// 1. クライアントの初期化
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel],
});

// 2. グローバル変数をクライアントに統合
client.guildVoiceManagers = new Map();
client.speakerCache = [];
client.commands = new Collection();

// 3. グローバルエラーハンドリング
process.on('unhandledRejection', (reason, p) => {
    console.error(`${shardPrefix} Unhandled Rejection:`, reason);
    sendErrorLog(client, reason instanceof Error ? reason : new Error(String(reason)), { place: 'Unhandled Rejection (Global)' });
});
process.on('uncaughtException', (err) => {
    console.error(`${shardPrefix} Uncaught Exception:`, err);
    sendErrorLog(client, err, { place: 'Uncaught Exception (Global)' });
});

// グレースフルシャットダウン: SIGTERM / SIGINT でクレームを解放してから終了
async function gracefulShutdown(signal) {
    console.log(`${shardPrefix} [System] ${signal} 受信。クレームを解放してシャットダウンします...`);
    try {
        const resolveBotInstanceId = () => {
            const explicit = String(process.env.BOT_INSTANCE_ID || '').trim();
            const shardId = Array.isArray(client?.shard?.ids) && Number.isInteger(client.shard.ids[0]) ? client.shard.ids[0] : 'single';
            const botBase = explicit || client?.user?.id || process.env.CLIENT_ID || 'unknown-bot';
            return `${botBase}:shard-${shardId}`;
        };
        await releaseVoiceChannelClaimsByOwner(resolveBotInstanceId());
        console.log(`${shardPrefix} [System] クレーム解放完了。`);
    } catch (e) {
        console.warn(`${shardPrefix} [System] シャットダウン時のクレーム解放に失敗しました: ${e.message}`);
    }
    process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// 4. ハンドラーの読み込み
const handlersPath = path.join(__dirname, 'handlers');
const handlerFiles = fs.readdirSync(handlersPath).filter(file => file.endsWith('.js'));

for (const file of handlerFiles) {
    require(path.join(handlersPath, file))(client);
}

// 5. VoiceManager解放イベントのリスナー
client.on('managerDestroyed', async (guildId) => {
    if (client.guildVoiceManagers.has(guildId)) {
        client.guildVoiceManagers.delete(guildId);
        console.log(`${shardPrefix} [System] Guild ${guildId} のVoiceManagerをメモリから解放しました。`);
        await updateActivity(client);
    }
});

// 6. 定期モニタリングタスク
client.startMonitoring = () => {
    if (client.monitorTimer) {
        clearInterval(client.monitorTimer);
        client.monitorTimer = null;
    }

    if (!isMaintenanceShard) {
        console.log(`${shardPrefix} [System] 非メンテナンスシャードのためモニタリングをスキップします。`);
        return;
    }

    const { MONITOR_CHANNEL_ID, MONITOR_INTERVAL_MINUTES } = process.env;
    const monitorInterval = (parseInt(MONITOR_INTERVAL_MINUTES, 10) || 60) * 60 * 1000;

    if (MONITOR_CHANNEL_ID && monitorInterval > 0) {
        client.monitorTimer = setInterval(async () => {
            const stats = getAndResetStats();

            const durationMin = Math.round(stats.durationMs / 60000);
            const reqPerMin = durationMin > 0 ? (stats.totalRequests / durationMin).toFixed(2) : '0.00';
            const hitRate = stats.totalRequests > 0 ? ((stats.cacheHits / (stats.cacheHits + stats.cacheMisses)) * 100).toFixed(1) : 0;
            const activeConnections = client.guildVoiceManagers.size;

            // 純粋な生成レイテンシ (ActiveSpeech待機などを含まない)
            const latencyStats = getAverageLatencyStats(durationMin / 60);
            const latencyText = latencyStats.count > 0 ? `${latencyStats.avg}ms` : '-';

            // ★追加: ワーカーごとの統計情報を作成
            const workerStats = engineSelector.getWorkerStats();
            let workerFieldText = '';

            if (workerStats.length > 0) {
                workerFieldText = workerStats.map(w => {
                    const statusIcon = w.isDown ? '🔴' : '🟢';
                    // URLは長すぎる場合があるのでIP/ポートだけ出すなど工夫しても良いですが、一旦そのまま表示
                    const shortUrl = w.url.replace('http://', '').replace(/\/$/, '');
                    return `${statusIcon} \`${shortUrl}\`\n└ **${w.count}** req | **${w.avgSpeed}** ms/char | Avg **${w.avgLatency}** ms`;
                }).join('\n\n');
            } else {
                workerFieldText = 'No workers loaded.';
            }

            // --- CSV保存処理 ---
            try {
                const reportsDir = path.join(__dirname, 'reports');
                if (!fs.existsSync(reportsDir)) {
                    fs.mkdirSync(reportsDir);
                }

                const csvFilePath = path.join(reportsDir, 'system_report.csv');
                const fileExists = fs.existsSync(csvFilePath);

                if (!fileExists) {
                    const header = 'Timestamp,StartTime,EndTime,DurationMin,TotalRequests,ReqPerMin,VoicevoxRequests,OjtRequests,CacheHits,CacheMisses,HitRate,ActiveConnections\n';
                    fs.writeFileSync(csvFilePath, header, 'utf8');
                }

                const nowIso = new Date().toISOString();
                const startTimeIso = new Date(stats.startTime).toISOString();
                const endTimeIso = new Date(stats.endTime).toISOString();

                const row = `${nowIso},${startTimeIso},${endTimeIso},${durationMin},${stats.totalRequests},${reqPerMin},${stats.voicevoxRequests},${stats.ojtRequests},${stats.cacheHits},${stats.cacheMisses},${hitRate},${activeConnections}\n`;

                fs.appendFileSync(csvFilePath, row, 'utf8');
                console.log(`[Report] CSV保存完了: ${csvFilePath}`);

            } catch (error) {
                console.error('CSVレポート保存中にエラーが発生しました:', error);
                sendErrorLog(client, error, { place: 'CSV Report Save' });
            }
            // ------------------

            // Discordへのレポート送信
            const channel = await client.channels.fetch(MONITOR_CHANNEL_ID).catch(() => null);
            if (!channel || !channel.isTextBased()) return;

            const embed = new EmbedBuilder()
                .setTitle(isShardedProcess ? `📊 Bot Usage Report (Shard ${currentShardId})` : '📊 Bot Usage Report')
                .setColor(0x00FF00)
                .setDescription(`過去 ${durationMin} 分間の稼働統計`)
                .addFields(
                    { name: 'Total Requests', value: `${stats.totalRequests} (${reqPerMin} req/min)`, inline: true },
                    { name: 'Cache Hit Rate', value: `${hitRate}% (${stats.cacheHits} hit / ${stats.cacheMisses} miss)`, inline: true },
                    { name: 'Gen Latency (Avg)', value: latencyText, inline: true }, // 名称変更: Gen Latency
                    { name: 'Engine Breakdown', value: `VOICEVOX: ${stats.voicevoxRequests}\nOpen JTalk: ${stats.ojtRequests}`, inline: false },
                    { name: 'Active Connections', value: `${activeConnections} VCs`, inline: true },
                    { name: '🏗️ Worker Status', value: workerFieldText || 'None', inline: false } // ★ 追加
                )
                .setTimestamp();

            await channel.send({ embeds: [embed] }).catch(console.error);

            // ★追加: ViewerConnector への統計送信
            if (client.viewerConnector) {
                const viewerStats = {
                    bot_name: 'UX-TTS-Bot',
                    timestamp: new Date().toISOString(),
                    duration_min: durationMin,
                    total_requests: stats.totalRequests,
                    req_per_min: parseFloat(reqPerMin),
                    cache_hit_rate: parseFloat(hitRate),
                    cache_hits: stats.cacheHits,
                    cache_misses: stats.cacheMisses,
                    avg_latency_ms: latencyStats.count > 0 ? latencyStats.avg : null,
                    voicevox_requests: stats.voicevoxRequests,
                    ojtalk_requests: stats.ojtRequests,
                    active_connections: activeConnections,
                    workers: workerStats.map(w => ({
                        url: w.url.replace('http://', '').replace(/\/$/, ''),
                        is_down: w.isDown,
                        request_count: w.count,
                        avg_speed: w.avgSpeed,
                        avg_latency: w.avgLatency
                    }))
                };
                client.viewerConnector.sendStats(viewerStats);
            }

        }, monitorInterval);
        console.log(`${shardPrefix} [System] モニタリングレポートを ${MONITOR_CHANNEL_ID} に ${MONITOR_INTERVAL_MINUTES} 分ごとに設定しました。`);
    } else {
        console.log(`${shardPrefix} [System] モニタリング設定が無効なため、レポート送信を停止しました。`);
    }
};

// 初回起動時にモニタリングを開始
client.startMonitoring();

// ★追加: ViewerConnector の初期化
const { VIEWER_SERVER_URL } = process.env;
if (!isMaintenanceShard) {
    console.log(`${shardPrefix} [System] 非メンテナンスシャードのため ViewerConnector を無効化します。`);
} else if (VIEWER_SERVER_URL) {
    client.viewerConnector = new ViewerConnector(VIEWER_SERVER_URL);
    client.viewerConnector.connect();
    console.log(`${shardPrefix} [System] ViewerConnector initialized with URL: ${VIEWER_SERVER_URL}`);
} else {
    console.log(`${shardPrefix} [System] VIEWER_SERVER_URL not set. ViewerConnector disabled.`);
}

// ダッシュボード起動 (Layer-E移行後はデフォルト無効)
if (!enableLayerADashboard) {
    console.log(`${shardPrefix} [System] Layer-A 内蔵ダッシュボードは無効です。Layer-E を利用してください。`);
} else if (isMaintenanceShard) {
    try {
        const startDashboard = require('./dashboard/server');
        startDashboard(client);
    } catch (e) {
        console.error(`${shardPrefix} ダッシュボードの起動に失敗しました:`, e);
    }
} else {
    console.log(`${shardPrefix} [System] 非メンテナンスシャードのためダッシュボードを起動しません。`);
}

// 7. ログイン
if (!DISCORD_BOT_TOKEN) {
    console.error('エラー: .env ファイルに DISCORD_BOT_TOKEN が設定されていません。');
    process.exit(1);
}
console.log(`${shardPrefix} [System] Current UV_THREADPOOL_SIZE: ${process.env.UV_THREADPOOL_SIZE}`);

// ★★★ 検証用設定の初期化 ★★★
client.devSettings = {
    enableChunking: true, // 文章分割: ON
    enableCache: true,    // キャッシュ: ON
    enablePreload: true   // 先行生成: ON
};
console.log(`${shardPrefix} [System] Dev Settings Initialized:`, client.devSettings);
// ★★★★★★★★★★★★★★★★★

client.login(DISCORD_BOT_TOKEN);
