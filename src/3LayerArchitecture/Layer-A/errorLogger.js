const { EmbedBuilder } = require('discord.js');

// ==========================================
// ★ ギルド別エラーログ蓄積 (メモリ内リングバッファ)
// ==========================================
const MAX_ENTRIES_PER_GUILD = 50;
const MAX_GLOBAL_ENTRIES = 200;

// guildId -> [{ timestamp, place, message, details, workerUrl }]
const guildErrorLogs = new Map();
// 全体ログ (ギルド横断)
const globalErrorLog = [];

/**
 * エラーをメモリ内ログに記録する
 * @param {Object} entry { guildId, place, message, details, workerUrl }
 */
function recordError(entry) {
    const { guildId } = entry;
    const record = {
        timestamp: new Date().toISOString(),
        place: entry.place || 'Unknown',
        message: entry.message || 'Unknown Error',
        details: entry.details || null,
        workerUrl: entry.workerUrl || null
    };

    // ギルド別ログ
    if (guildId) {
        if (!guildErrorLogs.has(guildId)) {
            guildErrorLogs.set(guildId, []);
        }
        const logs = guildErrorLogs.get(guildId);
        logs.push(record);
        if (logs.length > MAX_ENTRIES_PER_GUILD) logs.shift();
    }

    // グローバルログ
    globalErrorLog.push({ ...record, guildId });
    if (globalErrorLog.length > MAX_GLOBAL_ENTRIES) globalErrorLog.shift();
}

/**
 * 指定ギルドの直近エラーログを取得する
 * @param {string} guildId
 * @param {number} count 取得件数 (デフォルト: 10)
 * @returns {Array} エラーログ配列 (新しい順)
 */
function getGuildErrors(guildId, count = 10) {
    const logs = guildErrorLogs.get(guildId) || [];
    return logs.slice(-count).reverse();
}

/**
 * 全ギルドの直近エラーログを取得する
 * @param {number} count 取得件数 (デフォルト: 20)
 * @returns {Array} エラーログ配列 (新しい順)
 */
function getGlobalErrors(count = 20) {
    return globalErrorLog.slice(-count).reverse();
}

/**
 * エラー統計サマリーを取得する
 * @param {string} [guildId] 指定時はそのギルドのみ
 * @param {number} [hours=24] 集計対象の時間幅
 * @returns {Object} { total, byPlace, byMessage, recentRate }
 */
function getErrorSummary(guildId, hours = 24) {
    const cutoff = Date.now() - (hours * 60 * 60 * 1000);
    const source = guildId ? (guildErrorLogs.get(guildId) || []) : globalErrorLog;
    const recent = source.filter(e => new Date(e.timestamp).getTime() > cutoff);

    const byPlace = {};
    const byMessage = {};
    for (const e of recent) {
        byPlace[e.place] = (byPlace[e.place] || 0) + 1;
        byMessage[e.message] = (byMessage[e.message] || 0) + 1;
    }

    return {
        total: recent.length,
        byPlace,
        byMessage,
        periodHours: hours
    };
}

/**
 * 指定されたチャンネルにエラーログを送信する関数
 * @param {import('discord.js').Client} client Discordクライアント
 * @param {Error|string} error エラーオブジェクトまたはメッセージ
 * @param {Object} context エラー発生時のコンテキスト情報 (guildId, place, details, workerUrlなど)
 */
async function sendErrorLog(client, error, context = {}) {
    // ★ 修正: 実行のたびに最新の process.env を参照するように変更
    const logChannelId = process.env.LOG_CHANNEL_ID;

    const errorMessage = error instanceof Error ? error.message : String(error);

    // ★ メモリ内ログに記録 (チャンネル送信の成否に関わらず常に記録)
    recordError({
        guildId: context.guildId,
        place: context.place,
        message: errorMessage,
        details: context.details || null,
        workerUrl: context.workerUrl || null
    });

    // 設定がない、またはクライアントが準備できていない場合は無視
    if (!logChannelId || !client || !client.isReady()) return;

    try {
        const channel = await client.channels.fetch(logChannelId).catch(() => null);
        if (!channel || !channel.isTextBased()) {
            console.warn('ログ送信先チャンネルが見つからないか、テキストチャンネルではありません。');
            return;
        }

        const stackTrace = error instanceof Error ? error.stack : null;

        const embed = new EmbedBuilder()
            .setTitle('⚠️ エラーが発生しました')
            .setColor(0xFF0000) // 赤色
            .addFields(
                { name: '発生場所', value: context.place || '不明', inline: true },
                { name: 'サーバーID', value: context.guildId || '不明', inline: true },
                { name: 'エラーメッセージ', value: `\`\`\`\n${errorMessage}\n\`\`\`` }
            )
            .setTimestamp();

        // ★ Layer-C からの詳細情報がある場合はフィールドに追加
        if (context.details) {
            const detailStr = typeof context.details === 'string'
                ? context.details
                : JSON.stringify(context.details, null, 2);
            const truncated = detailStr.length > 500 ? detailStr.substring(0, 500) + '...' : detailStr;
            embed.addFields({ name: 'Worker 詳細', value: `\`\`\`\n${truncated}\n\`\`\`` });
        }
        if (context.workerUrl) {
            embed.addFields({ name: 'Worker URL', value: context.workerUrl, inline: true });
        }

        // スタックトレースがある場合は詳細に追加 (長すぎる場合は切り詰め)
        if (stackTrace) {
            const cleanStack = stackTrace.length > 1000 ? stackTrace.substring(0, 1000) + '...' : stackTrace;
            embed.setDescription(`**Stack Trace:**\n\`\`\`js\n${cleanStack}\n\`\`\``);
        }

        await channel.send({ embeds: [embed] });

    } catch (e) {
        // ログ送信自体に失敗した場合はコンソールに出すだけにする（無限ループ防止）
        console.error('エラーログの送信中にさらにエラーが発生しました:', e);
    }
}

module.exports = { sendErrorLog, recordError, getGuildErrors, getGlobalErrors, getErrorSummary };