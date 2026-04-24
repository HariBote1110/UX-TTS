require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Collection, EmbedBuilder } = require('discord.js');
const fs = require('fs');
const path = require('path');
const { sendErrorLog } = require('./errorLogger');
const { getAndResetStats } = require('./utils/statsManager'); 
const { updateActivity } = require('./utils/helpers');
const startDashboard = require('./dashboard/server'); // ★ 追加

const { DISCORD_BOT_TOKEN } = process.env;

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
    console.error('Unhandled Rejection:', reason);
    sendErrorLog(client, reason instanceof Error ? reason : new Error(String(reason)), { place: 'Unhandled Rejection (Global)' });
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    sendErrorLog(client, err, { place: 'Uncaught Exception (Global)' });
});

// 4. ハンドラーの読み込み
const handlersPath = path.join(__dirname, 'handlers');
const handlerFiles = fs.readdirSync(handlersPath).filter(file => file.endsWith('.js'));

for (const file of handlerFiles) {
    require(path.join(handlersPath, file))(client);
}

// ★ 5. VoiceManager解放イベントのリスナー (ここが修正ポイント)
// voiceManager.js が発信する 'managerDestroyed' を受け取り、メモリから削除して表示を更新
client.on('managerDestroyed', async (guildId) => {
    if (client.guildVoiceManagers.has(guildId)) {
        client.guildVoiceManagers.delete(guildId);
        console.log(`[System] Guild ${guildId} のVoiceManagerをメモリから解放しました。`);
        // アクティビティ（xVCで読み上げ中）の数値を更新
        await updateActivity(client);
    }
});

// 6. 定期モニタリングタスク (リロード対応版)
client.startMonitoring = () => {
    // 既にタイマーが動いていれば停止
    if (client.monitorTimer) {
        clearInterval(client.monitorTimer);
        client.monitorTimer = null;
    }

    // 最新の process.env から設定を読み込む
    const { MONITOR_CHANNEL_ID, MONITOR_INTERVAL_MINUTES } = process.env;
    const monitorInterval = (parseInt(MONITOR_INTERVAL_MINUTES, 10) || 60) * 60 * 1000;

    if (MONITOR_CHANNEL_ID && monitorInterval > 0) {
        client.monitorTimer = setInterval(async () => {
            const stats = getAndResetStats();
            
            // 統計データの計算
            const durationMin = Math.round(stats.durationMs / 60000);
            const reqPerMin = durationMin > 0 ? (stats.totalRequests / durationMin).toFixed(2) : '0.00';
            const hitRate = stats.totalRequests > 0 ? ((stats.cacheHits / (stats.cacheHits + stats.cacheMisses)) * 100).toFixed(1) : 0;
            const activeConnections = client.guildVoiceManagers.size;

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
                .setTitle('📊 Bot Usage Report')
                .setColor(0x00FF00)
                .setDescription(`過去 ${durationMin} 分間の稼働統計`)
                .addFields(
                    { name: 'Total Requests', value: `${stats.totalRequests} (${reqPerMin} req/min)`, inline: true },
                    { name: 'Cache Hit Rate', value: `${hitRate}% (${stats.cacheHits} hit / ${stats.cacheMisses} miss)`, inline: true },
                    { name: '\u200B', value: '\u200B', inline: true },
                    { name: 'Engine Breakdown', value: `VOICEVOX: ${stats.voicevoxRequests}\nOpen JTalk: ${stats.ojtRequests}`, inline: false },
                    { name: 'Active Connections', value: `${activeConnections} VCs`, inline: true }
                )
                .setTimestamp();

            await channel.send({ embeds: [embed] }).catch(console.error);

        }, monitorInterval);
        console.log(`[System] モニタリングレポートを ${MONITOR_CHANNEL_ID} に ${MONITOR_INTERVAL_MINUTES} 分ごとに設定しました。`);
    } else {
        console.log('[System] モニタリング設定が無効なため、レポート送信を停止しました。');
    }
};

// 初回起動時にモニタリングを開始
client.startMonitoring();

// ★ ダッシュボード起動 (clientを渡す)
try {
    startDashboard(client);
} catch (e) {
    console.error('ダッシュボードの起動に失敗しました:', e);
}

// 7. ログイン
if (!DISCORD_BOT_TOKEN) {
    console.error('エラー: .env ファイルに DISCORD_BOT_TOKEN が設定されていません。');
    process.exit(1);
}
client.login(DISCORD_BOT_TOKEN);