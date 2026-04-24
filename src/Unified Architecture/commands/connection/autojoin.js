const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { getAutoVCGenerators } = require('../../database');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('autovc')
        .setDescription('自動チャンネル作成機能(AutoVC)の管理パネルを開きます')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

    async execute(interaction) {
        const generators = getAutoVCGenerators(interaction.guild.id);

        const embed = new EmbedBuilder()
            .setTitle('🔊 AutoVC 設定パネル')
            .setDescription('自動チャンネル作成機能の設定を管理します。\n「トリガー」となるVCに入室すると、自動的に個室が作成されます。')
            .setColor(0x00AAFF);

        if (generators.length > 0) {
            const list = generators.map(g => {
                const trigger = interaction.guild.channels.cache.get(g.channel_id);
                const category = interaction.guild.channels.cache.get(g.category_id);
                const archive = interaction.guild.channels.cache.get(g.text_channel_id);
                
                return `**📌 トリガー:** ${trigger ? trigger.name : 'Unknown'}\n` +
                       `　↳ **作成先:** ${category ? category.name : 'Unknown'}\n` +
                       `　↳ **ログ保存:** ${archive ? archive.name : 'なし'}\n` +
                       `　↳ **命名:** \`${g.naming_pattern}\``;
            }).join('\n\n');
            embed.addFields({ name: '現在稼働中の設定', value: list });
        } else {
            embed.addFields({ name: '設定状況', value: '⚠️ 現在、自動作成設定は登録されていません。' });
        }

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('autovc_config_add')
                .setLabel('新規作成')
                .setStyle(ButtonStyle.Success)
                .setEmoji('➕'),
            new ButtonBuilder()
                .setCustomId('autovc_config_delete')
                .setLabel('設定削除')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🗑️')
                .setDisabled(generators.length === 0),
            new ButtonBuilder()
                .setCustomId('autovc_config_refresh')
                .setLabel('更新')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('🔄')
        );

        await interaction.reply({ embeds: [embed], components: [row], flags: [MessageFlags.Ephemeral] });
    },
};