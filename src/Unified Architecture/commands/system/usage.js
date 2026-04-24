const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { getGuildUsage, getServerActivationInfo, getLicenseKeyInfo, getCurrentMonth } = require('../../database');

const vvxCharThreshold = parseInt(process.env.VOICEVOX_CHAR_THRESHOLD, 10) || 0;
const totalCharLimit = parseInt(process.env.TOTAL_CHAR_LIMIT, 10) || 0;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('usage')
        .setDescription('今月のサーバーの読み上げ文字数と制限状況を確認します。'),
        
    async execute(interaction, client) {
        const { guildId } = interaction;
        const usage = getGuildUsage(guildId); 
        
        // ★ 小数対応のフォーマット (例: 1,234.5)
        const formatChars = (count) => (count ?? 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 1 }); 
        
        let status = 'VOICEVOXが利用可能';
        let remainingVvxText = '---'; 
        let remainingTotalText = '---'; 
        let licenseDetails = null; 

        if (usage.hasLicense) {
            status = `**プレミアムライセンス適用中** ✨`;
            remainingVvxText = '無制限';
            remainingTotalText = '無制限';
            
            const activationInfo = getServerActivationInfo(guildId);
            if (activationInfo) {
                const keyInfo = getLicenseKeyInfo(activationInfo.license_key);
                const remainingActivations = keyInfo ? Math.max(0, keyInfo.max_activations - keyInfo.current_activations) : '?';
                licenseDetails = `キー: \`${activationInfo.license_key.substring(0, 4)}...\` (残り ${remainingActivations} 回サーバー移行可能)`;
            } else {
                 licenseDetails = 'ライセンス情報取得エラー'; 
            }
        } 
        else {
            remainingTotalText = totalCharLimit > 0 ? `残り **${formatChars(Math.max(0, totalCharLimit - usage.count))}** 文字` : '無制限';
            
            if (vvxCharThreshold > 0) {
                remainingVvxText = `残り **${formatChars(Math.max(0, vvxCharThreshold - usage.count))}** 文字`;
                 if (usage.useOjt && !usage.limitExceeded) {
                    status = 'Open JTalkに切替済み';
                }
            } else {
                remainingVvxText = '--- (OJT無効)'; 
            }
           
            if (usage.limitExceeded) {
                status = '上限超過 (読み上げ停止中)';
            }
        }

        const embed = new EmbedBuilder()
            .setTitle('📈 今月の読み上げ文字数') 
            .setColor(usage.hasLicense ? 0xFFD700 : 0x0099FF) 
            .setDescription(`このサーバーの ${getCurrentMonth()} の状況です。`)
            .addFields(
                { name: '現在のカウント', value: `**${formatChars(usage.count)}** 文字`, inline: true }, 
                { name: '現在のモード', value: status, inline: true },
                ...(licenseDetails ? [{ name: 'ライセンス情報', value: licenseDetails, inline: false }] : []),
                { name: '\u200B', value: '\u200B' }, 
                { name: 'Open JTalkへの切替まで', value: remainingVvxText, inline: true }, 
                { name: '読み上げ停止まで', value: remainingTotalText, inline: true }, 
            )
            .setFooter({ text: 'カウントは毎月1日にリセットされます。' });

        await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
    },
};