const { SlashCommandBuilder, MessageFlags } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('set_pitch')
        .setDescription('あなたの読み上げピッチを設定します。（VOICEVOX専用）')
        .addNumberOption(option => 
            option.setName('value')
                .setDescription('ピッチ (-0.15 から 0.15 まで、デフォルト 0.0)')
                .setMinValue(-0.15)
                .setMaxValue(0.15)
                .setRequired(true)),
        
    async execute(interaction, client) {
        const { guildId } = interaction;
        const manager = client.guildVoiceManagers.get(guildId);

        if (!manager || !manager.isActive()) {
            await interaction.reply({ 
                content: 'このコマンドは、まず `/join` でBotをボイスチャンネルに参加させてから使用してください。', 
                flags: [MessageFlags.Ephemeral] 
            });
            return;
        }

        const pitch = interaction.options.getNumber('value');
        manager.setPitch(interaction.user.id, pitch); 
        
        await interaction.reply({
            content: `✅ あなたのピッチを **${pitch}** に設定しました。`,
            flags: [MessageFlags.Ephemeral]
        });
    },
};