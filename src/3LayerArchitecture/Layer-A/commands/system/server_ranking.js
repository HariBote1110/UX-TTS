const { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const { getAllGuildUsage, getCurrentMonth } = require('../../database');
const { createStatusMessage } = require('../../utils/helpers');

// .env から管理サーバーIDを取得
const ADMIN_GUILD_ID = process.env.ADMIN_GUILD_ID;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('server_ranking')
        .setDescription('【管理者用】全サーバーの月間利用量をランキング形式で表示します（ID表示）')
        // ★ 重要: 管理者権限(Administrator)を持つユーザーのみ表示・実行可能にする
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    async execute(interaction, client) {
        // ★ ガード処理: 管理サーバー以外からの実行を完全にブロック
        if (ADMIN_GUILD_ID && interaction.guildId !== ADMIN_GUILD_ID) {
            return interaction.reply(createStatusMessage('warning', 'このコマンドは管理サーバー限定です。', {
                title: '🚫 実行不可',
                flags: [MessageFlags.Ephemeral]
            }));
        }

        // 全サーバーのデータを取得
        const allUsage = await getAllGuildUsage();

        // 文字数が多い順にソート
        const sortedUsage = allUsage.sort((a, b) => b.count - a.count);

        // 上位20件のみ表示
        const topUsage = sortedUsage.slice(0, 20);
        const totalServers = allUsage.length;

        const totalChars = allUsage.reduce((sum, item) => sum + item.count, 0);
        const fmt = (num) => (num ?? 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 1 });

        const rankingText = topUsage.map((usage, index) => {
            const rank = index + 1;
            // ライセンス情報は getGuildUsage 経由でないとつかないため、ここではIDとカウントのみ
            return `**#${rank}** \`ID: ${usage.guild_id}\`: **${fmt(usage.count)}** 文字`;
        }).join('\n');

        const embed = new EmbedBuilder()
            .setTitle(`📊 サーバー利用量ランキング (${getCurrentMonth()})`)
            .setColor(0x00AAFF)
            .setDescription(`現在稼働中の全 **${totalServers}** サーバー中、上位20サーバーを表示します。`)
            .addFields(
                { name: '総合計読み上げ文字数', value: `${fmt(totalChars)} 文字`, inline: false },
                { name: 'ランキング (Top 20)', value: rankingText || 'データなし', inline: false }
            )
            .setFooter({ text: '※プライバシー保護のためサーバー名はIDで表示しています' })
            .setTimestamp();

        await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
    },
};
