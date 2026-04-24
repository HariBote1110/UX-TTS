const { 
    SlashCommandBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    EmbedBuilder,
    MessageFlags
} = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('dictionary')
        .setDescription('サーバーの読み上げ辞書を管理します。'),

    async execute(interaction, client) {
        const embed = new EmbedBuilder()
            .setTitle('📖 辞書設定')
            .setDescription('以下のボタンから操作を選択してください。')
            .setColor(0x00AAFF);

        const row1 = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('dict_add_modal_open')
                    .setLabel('登録 / 編集')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('➕'),
                new ButtonBuilder()
                    .setCustomId('dict_delete_menu_open') 
                    .setLabel('選択して削除')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('🗑️'),
                new ButtonBuilder()
                    .setCustomId('dict_delete_modal_open') 
                    .setLabel('入力して削除')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('⌨️'),
                new ButtonBuilder()
                    .setCustomId('dict_list_show')
                    .setLabel('一覧を表示')
                    .setStyle(ButtonStyle.Primary)
                    .setEmoji('📄')
            );

        // ★ 新規: インポート・エクスポートボタン
        const row2 = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('dict_export_file')
                    .setLabel('エクスポート')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('📤'),
                new ButtonBuilder()
                    .setCustomId('dict_import_start')
                    .setLabel('インポート')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('📥')
            );

        await interaction.reply({ embeds: [embed], components: [row1, row2], flags: [MessageFlags.Ephemeral] });
    },
};