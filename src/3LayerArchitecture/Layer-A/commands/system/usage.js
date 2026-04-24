const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { getGuildUsage, getServerActivationInfo, getLicenseKeyInfo, getCurrentMonth } = require('../../database');
const { isVvxHalfCostPeriod } = require('../../voiceManager');

const vvxCharThreshold = parseInt(process.env.VOICEVOX_CHAR_THRESHOLD, 10) || 0;
const totalCharLimit = parseInt(process.env.TOTAL_CHAR_LIMIT, 10) || 0;

async function buildOverviewEmbed(guildId) {
    const usage = await getGuildUsage(guildId);
    const formatChars = (count) => (count ?? 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 1 });
    const halfCost = isVvxHalfCostPeriod();

    let status = 'VOICEVOXが利用可能';
    let remainingVvxText = '---';
    let remainingTotalText = '---';
    let licenseDetails = null;

    if (usage.hasLicense) {
        status = `**プレミアムライセンス適用中** ✨`;
        remainingVvxText = '無制限';
        remainingTotalText = '無制限';

        const activationInfo = await getServerActivationInfo(guildId);
        if (activationInfo) {
            const keyInfo = await getLicenseKeyInfo(activationInfo.license_key);
            const remainingActivations = keyInfo ? Math.max(0, keyInfo.max_activations - keyInfo.current_activations) : '?';
            licenseDetails = `キー: \`${activationInfo.license_key.substring(0, 4)}...\` (残り ${remainingActivations} 回サーバー移行可能)`;
        } else {
            licenseDetails = 'ライセンス情報取得エラー';
        }
    } else {
        remainingTotalText = totalCharLimit > 0 ? `残り **${formatChars(Math.max(0, totalCharLimit - usage.count))}** 文字` : '無制限';

        if (vvxCharThreshold > 0) {
            remainingVvxText = `残り **${formatChars(Math.max(0, vvxCharThreshold - usage.count))}** 文字`;
            if (usage.useOjt && !usage.limitExceeded) {
                status = 'Open JTalkに切替済み';
            }
        } else {
            remainingVvxText = '--- (Open JTalk無効)';
        }

        if (usage.limitExceeded) {
            status = '上限超過 (読み上げ停止中)';
        }
    }

    const discountBanner = halfCost
        ? '\n\n🈹 **割引時間帯（JST 05:00〜15:00）**\nVOICEVOX消費は **0.5倍**・Open JTalk消費は **0** でカウントされています。'
        : '';

    const embed = new EmbedBuilder()
        .setTitle('📈 今月の読み上げ文字数')
        .setColor(halfCost ? 0x5865F2 : usage.hasLicense ? 0xFFD700 : 0x0099FF)
        .setDescription(`このサーバーの ${getCurrentMonth()} の状況です。${discountBanner}`)
        .addFields(
            { name: '現在のカウント', value: `**${formatChars(usage.count)}** 文字`, inline: true },
            { name: '現在のモード', value: status, inline: true },
            ...(licenseDetails ? [{ name: 'ライセンス情報', value: licenseDetails, inline: false }] : []),
            { name: '\u200B', value: '\u200B' },
            { name: 'Open JTalkへの切替まで', value: remainingVvxText, inline: true },
            { name: '読み上げ停止まで', value: remainingTotalText, inline: true },
        )
        .setFooter({ text: 'カウントは毎月1日にリセットされます。' });

    return embed;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('usage')
        .setDescription('今月のサーバーの読み上げ文字数と制限状況を確認します。'),

    async execute(interaction, client) {
        const { guildId } = interaction;
        const embed = await buildOverviewEmbed(guildId);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('usage:history')
                .setLabel('📅 日別履歴 (直近7日)')
                .setStyle(ButtonStyle.Secondary),
        );

        await interaction.reply({ embeds: [embed], components: [row], flags: [MessageFlags.Ephemeral] });
    },

    buildOverviewEmbed,
};
