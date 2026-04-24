const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { VoiceConnectionManager } = require('../../voiceManager');
const { updateActivity, getAnnouncement, createStatusMessage } = require('../../utils/helpers');
const feedbackManager = require('../../utils/feedbackManager');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('join')
        .setDescription('Botをボイスチャンネルに接続し、このテキストチャンネルの読み上げを開始します。'),

    async execute(interaction, client) {
        // 接続処理は時間がかかる場合があるため、先に応答を保留(defer)します
        // これにより "The application did not respond" エラーを防ぎます
        await interaction.deferReply();

        const { guildId } = interaction;
        let manager = client.guildVoiceManagers.get(guildId);

        if (!manager) {
            manager = new VoiceConnectionManager(client, guildId);
            client.guildVoiceManagers.set(guildId, manager);
        }

        const member = interaction.member;
        const voiceChannel = member.voice.channel;

        if (!voiceChannel) {
            return interaction.editReply(createStatusMessage('error', 'VCに参加してからコマンドを使用してください。'));
        }
        if (!voiceChannel.joinable || !voiceChannel.speakable) {
            return interaction.editReply(createStatusMessage('error', 'VCへの参加・発言権限がありません。'));
        }

        // 既に同じVCにいるかチェック (メッセージの出し分け用)
        const isSameVoice = manager.getVoiceChannel() && manager.getVoiceChannel().id === voiceChannel.id;
        const isConnectedToOtherVoice = manager.getVoiceChannel() && manager.getVoiceChannel().id !== voiceChannel.id;

        if (isConnectedToOtherVoice) {
            const textChannelId = interaction.channel?.id || interaction.channelId || '';
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`joinopt:move:${voiceChannel.id}:${textChannelId}:${interaction.user.id}`)
                    .setLabel('このBotを移動')
                    .setStyle(ButtonStyle.Primary),
                new ButtonBuilder()
                    .setCustomId(`joinopt:assign:${voiceChannel.id}:${textChannelId}:${interaction.user.id}`)
                    .setLabel('別botに割り当て')
                    .setStyle(ButtonStyle.Success)
            );

            return interaction.editReply(createStatusMessage(
                'info',
                `現在このBotは **${manager.getVoiceChannel().name}** に接続中です。\n**${voiceChannel.name}** への接続方法を選択してください。`,
                { title: '🔀 接続先の選択', components: [row] }
            ));
        }

        // 接続実行 (安定版ロジックを使用)
        const success = await manager.connect(voiceChannel, interaction.channel?.id || interaction.channelId || '');
        if (success) {
            const news = getAnnouncement();
            let replyContent = '';

            if (isSameVoice) {
                // VC移動なし、テキストチャンネル変更のみの場合
                replyContent = `✅ 読み上げ対象をこのチャンネルに変更しました。`;
            } else {
                // 新規接続の場合
                replyContent = `✅ VCに接続し、このチャンネルの読み上げを開始します。`;
            }

            // お知らせ設定があれば末尾に追加
            if (news.enabled && news.vc_suffix) {
                replyContent += `\n${news.vc_suffix}`;
            }

            await interaction.editReply(createStatusMessage('success', replyContent));
            await updateActivity(client);

            // フィードバックパネル (1日1回、接続成功時のみ)
            if (feedbackManager.canSubmit(interaction.user.id)) {
                const feedbackRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('feedback:good').setLabel('役に立ってる').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('feedback:neutral').setLabel('普通').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId('feedback:bad').setLabel('不満がある').setStyle(ButtonStyle.Danger),
                );
                await interaction.followUp({
                    content: '💭 よかったらフィードバックをお寄せください！今日の読み上げはいかがでしたか？（1日1回）',
                    components: [feedbackRow],
                    flags: [MessageFlags.Ephemeral],
                });
            }
        } else {
            const failureCode = typeof manager.getLastConnectErrorCode === 'function' ? manager.getLastConnectErrorCode() : null;
            if (failureCode === 'claimed_by_other_bot') {
                const textChannelId = interaction.channel?.id || interaction.channelId || '';
                const assignRow = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`joinopt:assign:${voiceChannel.id}:${textChannelId}:${interaction.user.id}`)
                        .setLabel('別のBotを割り当てる')
                        .setStyle(ButtonStyle.Success)
                );
                return interaction.editReply(createStatusMessage(
                    'info',
                    `**${voiceChannel.name}** は現在別のBotが担当中です。\n「別のBotを割り当てる」で空いているBotを呼び出せます。`,
                    { title: '🤖 Bot割り当て', components: [assignRow] }
                ));
            }

            // 失敗時
            // マネージャーのクリーンアップはvoiceManager内で自動で行われるため、ここではメッセージのみ
            await interaction.editReply(createStatusMessage('error', 'VCへの接続に失敗しました。'));
        }
    },
};
