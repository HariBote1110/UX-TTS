const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const easterEggManager = require('../../utils/easterEggManager');
const { createStatusMessage } = require('../../utils/helpers');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('easteregg')
        .setDescription('イースターエッグ（隠し音声）機能の設定を行います。')
        .addBooleanOption(option =>
            option.setName('enabled')
                .setDescription('OFFにすると、イースターエッグが発動しなくなります。')
                .setRequired(false)),

    async execute(interaction) {
        const enable = interaction.options.getBoolean('enabled');
        const { user } = interaction;

        // 引数がない場合は状態表示
        if (enable === null) {
            const isOptedOut = easterEggManager.isUserOptedOut(user.id);
            await interaction.reply(createStatusMessage(
                'info',
                `現在のイースターエッグ設定: **${isOptedOut ? 'OFF（オプトアウト中）' : 'ON'}**`,
                { flags: [MessageFlags.Ephemeral] }
            ));
            return;
        }

        // 設定変更
        if (enable) {
            // 有効化 = オプトアウトリストから削除
            const removed = easterEggManager.removeOptOut(user.id);
            await interaction.reply(createStatusMessage(
                removed ? 'success' : 'info',
                removed
                    ? 'イースターエッグを **ON** にしました。\n特定のフレーズを入力すると、隠し音声が再生されるようになります。🥚'
                    : 'イースターエッグは既に **ON** です。',
                { flags: [MessageFlags.Ephemeral] }
            ));
        } else {
            // 無効化 = オプトアウトリストに追加
            const added = easterEggManager.addOptOut(user.id);
            await interaction.reply(createStatusMessage(
                added ? 'success' : 'info',
                added
                    ? 'イースターエッグを **OFF** にしました。\n通常の音声合成のみが再生されます。'
                    : 'イースターエッグは既に **OFF** です。',
                { flags: [MessageFlags.Ephemeral] }
            ));
        }
    },
};
