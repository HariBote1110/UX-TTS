const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const { createSpeakerUIPayload, createStatusMessage } = require('../../utils/helpers');
const { BOT_OWNER_ID } = process.env;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('speaker')
        .setDescription('読み上げ話者を設定します。')
        .addUserOption(option => 
            option.setName('user')
                .setDescription('設定対象のユーザー (管理者のみ)')
                .setRequired(false)
        )
        .addBooleanOption(option =>
            option.setName('server_default')
                .setDescription('サーバー全体のデフォルト話者を設定 (管理者のみ)')
                .setRequired(false)
        ),
        
    async execute(interaction, client) {
        const { guildId, user, member } = interaction;
        const useServerDefault = interaction.options.getBoolean('server_default') || false;
        const targetUser = interaction.options.getUser('user') || user;
        const isAdmin = member.permissions.has(PermissionFlagsBits.Administrator) || user.id === BOT_OWNER_ID;

        if (useServerDefault && interaction.options.getUser('user')) {
            await interaction.reply(createStatusMessage(
                'error',
                '`server_default` と `user` は同時に指定できません。',
                { flags: [MessageFlags.Ephemeral] }
            ));
            return;
        }

        if (useServerDefault) {
            if (!isAdmin) {
                await interaction.reply(createStatusMessage(
                    'error',
                    'サーバー全体のデフォルト話者を設定するには管理者権限が必要です。',
                    { flags: [MessageFlags.Ephemeral] }
                ));
                return;
            }
        }

        // コマンド引数での指定時も権限チェック
        if (!useServerDefault && targetUser.id !== user.id) {
            if (!isAdmin) {
                // エラーメッセージは元々 Ephemeral なのでそのまま reply でOK
                await interaction.reply(createStatusMessage(
                    'error',
                    '他のユーザーの話者を設定するには管理者権限が必要です。',
                    { flags: [MessageFlags.Ephemeral] }
                ));
                return;
            }
        }

        if (!client.speakerCache || client.speakerCache.length === 0) {
            await interaction.reply(createStatusMessage(
                'warning',
                '話者リストを読み込み中です。通常1〜5秒で読み込まれますので、しばらくしてから再度お試しください。',
                { flags: [MessageFlags.Ephemeral] }
            ));
            return;
        }

        // ★修正: ここで Ephemeral フラグを指定して「考え中...」の状態を自分だけに見えるようにする
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            // editReply で内容を更新（すでに Ephemeral なのでそのまま送信される）
            if (useServerDefault) {
                await interaction.editReply(await createSpeakerUIPayload(client, 1, guildId, 'voicevox', member, 'guild'));
            } else {
                await interaction.editReply(await createSpeakerUIPayload(client, 1, targetUser.id, 'voicevox', member, 'user'));
            }
        } catch (error) {
            console.error('Speaker command error:', error);
            await interaction.editReply(createStatusMessage('error', 'メニューの生成に失敗しました。'));
        }
    },
};
