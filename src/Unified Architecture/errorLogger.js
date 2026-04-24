const { EmbedBuilder } = require('discord.js');

/**
 * 指定されたチャンネルにエラーログを送信する関数
 * @param {import('discord.js').Client} client Discordクライアント
 * @param {Error|string} error エラーオブジェクトまたはメッセージ
 * @param {Object} context エラー発生時のコンテキスト情報 (guildId, placeなど)
 */
async function sendErrorLog(client, error, context = {}) {
    // ★ 修正: 実行のたびに最新の process.env を参照するように変更
    const logChannelId = process.env.LOG_CHANNEL_ID;

    // 設定がない、またはクライアントが準備できていない場合は無視
    if (!logChannelId || !client || !client.isReady()) return;

    try {
        const channel = await client.channels.fetch(logChannelId).catch(() => null);
        if (!channel || !channel.isTextBased()) {
            console.warn('ログ送信先チャンネルが見つからないか、テキストチャンネルではありません。');
            return;
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
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

module.exports = { sendErrorLog };