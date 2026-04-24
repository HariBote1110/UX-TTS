const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const feedbackManager = require('../../../../utils/feedbackManager');

module.exports = async (interaction, client) => {
    const { customId, guildId, user } = interaction;

    if (!customId.startsWith('feedback:')) return false;

    const type = customId.split(':')[1]; // good | neutral | bad

    // 1日1回制限チェック
    if (!feedbackManager.canSubmit(user.id)) {
        await interaction.reply({
            content: '本日はすでにフィードバックをいただいています。ありがとうございます！',
            flags: [MessageFlags.Ephemeral]
        });
        return true;
    }

    if (type === 'bad') {
        // 詳細フィードバック用モーダルを表示 (showModalはupdate/replyと同時に呼べないため単独で)
        const modal = new ModalBuilder()
            .setCustomId('feedback_detail_modal_submit')
            .setTitle('ご不満の点をお聞かせください');

        const input = new TextInputBuilder()
            .setCustomId('feedback_detail_text')
            .setLabel('改善してほしい点・お気づきの点')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('例: 音声の品質、コマンドの使いにくさ、バグ など')
            .setRequired(true)
            .setMaxLength(1000);

        modal.addComponents(new ActionRowBuilder().addComponents(input));
        await interaction.showModal(modal);
        return true;
    }

    // good / neutral: ボタンを消してお礼メッセージに更新
    feedbackManager.markSubmitted(user.id);

    const thankYou = type === 'good'
        ? '😊 フィードバックありがとうございます！お役に立てて嬉しいです！'
        : '😌 フィードバックありがとうございます！ご意見は今後の改善に役立てます。';

    await interaction.update({ content: thankYou, components: [] });

    // ログチャンネルに記録
    await sendFeedbackLog(client, user, guildId, type, null);

    return true;
};

async function sendFeedbackLog(client, user, guildId, type, detail) {
    const logChannelId = process.env.FEEDBACK_CHANNEL_ID || process.env.LOG_CHANNEL_ID;
    if (!logChannelId || !client || !client.isReady()) return;

    const labels = { good: '役に立ってる 👍', neutral: '普通 😐', bad: '不満がある 👎' };
    const colors  = { good: 0x57F287, neutral: 0xFEE75C, bad: 0xED4245 };

    try {
        const channel = await client.channels.fetch(logChannelId).catch(() => null);
        if (!channel || !channel.isTextBased()) return;

        const embed = new EmbedBuilder()
            .setTitle('📬 ユーザーフィードバック')
            .setColor(colors[type] || 0x888888)
            .addFields(
                { name: '評価',       value: labels[type] || type,                          inline: true },
                { name: 'ユーザー',   value: `<@${user.id}> (${user.username})`,            inline: true },
                { name: 'サーバーID', value: guildId,                                        inline: true },
            )
            .setTimestamp();

        if (detail) {
            embed.addFields({ name: '詳細コメント', value: detail });
        }

        await channel.send({ embeds: [embed] });
    } catch (e) {
        console.error('[Feedback] Log send error:', e.message);
    }
}

module.exports.sendFeedbackLog = sendFeedbackLog;
