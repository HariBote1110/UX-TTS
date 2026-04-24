const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const dailyStats = require('../../../../utils/dailyStats');
const { buildOverviewEmbed } = require('../../../../commands/system/usage');

module.exports = async (interaction, client) => {
    const { customId, guildId } = interaction;

    if (!customId.startsWith('usage:')) return false;

    const action = customId.split(':')[1]; // history | overview

    if (action === 'history') {
        const history = dailyStats.getHistory(guildId, 7);
        const total = history.reduce((s, d) => s + d.chars, 0);
        const maxChars = Math.max(...history.map(d => d.chars), 1);
        const BAR_MAX = 12;

        const lines = history.map(({ date, chars }) => {
            const barLen = Math.round((chars / maxChars) * BAR_MAX);
            const bar = '█'.repeat(barLen) + '░'.repeat(BAR_MAX - barLen);
            return `\`${date}\`  ${bar}  **${chars.toLocaleString()}** 文字`;
        });

        const embed = new EmbedBuilder()
            .setTitle('📅 直近7日間の読み上げ文字数')
            .setColor(0x5865F2)
            .setDescription(lines.join('\n'))
            .setFooter({ text: `7日間合計: ${total.toLocaleString()} 文字` });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('usage:overview')
                .setLabel('⬅️ 今月の概要に戻る')
                .setStyle(ButtonStyle.Secondary),
        );

        await interaction.update({ embeds: [embed], components: [row] });
        return true;
    }

    if (action === 'overview') {
        const embed = await buildOverviewEmbed(guildId);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('usage:history')
                .setLabel('📅 日別履歴 (直近7日)')
                .setStyle(ButtonStyle.Secondary),
        );

        await interaction.update({ embeds: [embed], components: [row] });
        return true;
    }

    return false;
};
