const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { setUserActiveSpeech, getUserSettings } = require('../../database');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('activespeech')
        .setDescription('ActiveSpeech（発話中の読み上げ待機）機能の設定を行います。')
        .addBooleanOption(option =>
            option.setName('enabled')
                .setDescription('ONにすると、あなたが話している間、Botは新しい読み上げを開始しません。')
                .setRequired(false)), // ★ 任意に変更

    async execute(interaction, client) {
        const enable = interaction.options.getBoolean('enabled');
        const { guildId, user } = interaction;

        // 引数がない場合は状態表示
        if (enable === null) {
            const settings = getUserSettings(guildId, user.id);
            const isEnabled = settings.active_speech === 1;
            await interaction.reply({
                content: `現在の ActiveSpeech 設定: **${isEnabled ? 'ON' : 'OFF'}**`,
                flags: [MessageFlags.Ephemeral]
            });
            return;
        }

        // 設定変更
        setUserActiveSpeech(guildId, user.id, enable);

        const manager = client.guildVoiceManagers.get(guildId);
        if (manager && manager.isActive()) {
            manager.updateSelfDeaf();
        }

        await interaction.reply({
            content: enable 
                ? '✅ ActiveSpeech機能を **ON** にしました。\nあなたが話している間、Botは新しい読み上げの開始を待機します。（再生中の音声は止まりません）' 
                : '✅ ActiveSpeech機能を **OFF** にしました。\nあなたが話している間も、Botは通常通り読み上げを行います。',
            flags: [MessageFlags.Ephemeral]
        });
    },
};