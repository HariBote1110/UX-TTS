const { MessageFlags } = require('discord.js');
const { VoiceConnectionManager } = require('../../../../voiceManager');
const { createJoinRequest } = require('../../../../database');
const { updateActivity, createStatusMessage } = require('../../../../utils/helpers');

function parseJoinOption(customId) {
    const parts = String(customId).split(':');
    if (parts.length !== 5) return null;
    if (parts[0] !== 'joinopt') return null;

    const action = parts[1];
    const voiceChannelId = parts[2];
    const textChannelId = parts[3];
    const requestUserId = parts[4];

    if (!['move', 'assign'].includes(action)) return null;
    if (!voiceChannelId || !requestUserId) return null;

    return {
        action,
        voiceChannelId,
        textChannelId: textChannelId || null,
        requestUserId,
    };
}

module.exports = async (interaction, client) => {
    const parsed = parseJoinOption(interaction.customId);
    if (!parsed) return false;

    const { action, voiceChannelId, textChannelId, requestUserId } = parsed;
    if (interaction.user.id !== requestUserId) {
        await interaction.reply(createStatusMessage(
            'warning',
            'この操作はコマンド実行者のみ実行できます。',
            { flags: [MessageFlags.Ephemeral] }
        ));
        return true;
    }

    const guild = interaction.guild;
    if (!guild) {
        await interaction.update(createStatusMessage('error', 'Guild 情報を取得できませんでした。', { components: [] }));
        return true;
    }

    const voiceChannel = guild.channels.cache.get(voiceChannelId);
    if (!voiceChannel || !voiceChannel.isVoiceBased()) {
        await interaction.update(createStatusMessage('error', '指定されたボイスチャンネルが見つかりません。', { components: [] }));
        return true;
    }

    if (action === 'assign') {
        const request = await createJoinRequest(
            guild.id,
            voiceChannelId,
            textChannelId || interaction.channelId || '',
            interaction.user.id
        );

        if (!request) {
            await interaction.update(createStatusMessage('error', '別botへの割り当て要求に失敗しました。', { components: [] }));
            return true;
        }

        await interaction.update(createStatusMessage(
            'info',
            `別botへの割り当て要求を登録しました。空きインスタンスがあれば **${voiceChannel.name}** に参加します。`,
            { title: '📨 割り当て要求を送信', components: [] }
        ));
        return true;
    }

    let manager = client.guildVoiceManagers.get(guild.id);
    if (!manager) {
        manager = new VoiceConnectionManager(client, guild.id);
        client.guildVoiceManagers.set(guild.id, manager);
    }

    if (!voiceChannel.joinable || !voiceChannel.speakable) {
        await interaction.update(createStatusMessage('error', 'VCへの参加・発言権限がありません。', { components: [] }));
        return true;
    }

    const success = await manager.connect(voiceChannel, textChannelId || interaction.channelId || null);
    if (!success) {
        const failureCode = typeof manager.getLastConnectErrorCode === 'function' ? manager.getLastConnectErrorCode() : null;
        if (failureCode === 'claimed_by_other_bot') {
            await interaction.update(createStatusMessage('info', 'このVCは現在ほかのBotインスタンスが担当しています。', { components: [] }));
            return true;
        }

        await interaction.update(createStatusMessage('error', 'VCへの接続に失敗しました。', { components: [] }));
        return true;
    }

    await updateActivity(client);
    await interaction.update(createStatusMessage('success', `このBotを **${voiceChannel.name}** に移動しました。`, { components: [] }));
    return true;
};
