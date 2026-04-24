const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { VoiceConnectionManager } = require('../../voiceManager');
const { updateActivity, getAnnouncement } = require('../../utils/helpers'); // ★ getAnnouncementを追加

module.exports = {
    data: new SlashCommandBuilder()
        .setName('join')
        .setDescription('Botをボイスチャンネルに接続し、このテキストチャンネルの読み上げを開始します。'),
        
    async execute(interaction, client) {
        // ★ 応答期限切れを防ぐため、deferReplyを使用
        await interaction.deferReply({ flags: [MessageFlags.Ephemeral] });

        const { guildId } = interaction;
        let manager = client.guildVoiceManagers.get(guildId);

        if (!manager) {
            manager = new VoiceConnectionManager(client, guildId);
            client.guildVoiceManagers.set(guildId, manager);
        }

        const member = interaction.member;
        const voiceChannel = member.voice.channel;

        if (!voiceChannel) {
            return interaction.editReply({ content: '❌ VCに参加してからコマンドを使用してください。' });
        }
        if (!voiceChannel.joinable || !voiceChannel.speakable) {
            return interaction.editReply({ content: '❌ VCへの参加・発言権限がありません。' });
        }

        // 既に同じVCにいるかチェック (メッセージの出し分け用)
        const isSameVoice = manager.getVoiceChannel() && manager.getVoiceChannel().id === voiceChannel.id;

        const success = await manager.connect(voiceChannel, interaction.channel.id);
        
        if (success) {
            const news = getAnnouncement();
            let replyContent = '';

            // ★ VC名/IDを含まない一般化されたメッセージを使用
            if (isSameVoice) {
                replyContent = `✅ 読み上げ対象をこのチャンネルに変更しました。`;
            } else {
                replyContent = `✅ VCに接続し、このチャンネルの読み上げを開始します。`;
            }

            if (news.enabled && news.vc_suffix) {
                replyContent += news.vc_suffix;
            }

            await interaction.editReply({ content: replyContent, ephemeral: false });
            await updateActivity(client); 
        } else {
            // ★ 修正: 接続失敗時にマネージャーを削除する処理を削除。
            // マネージャーのクリーンアップはvoiceManager.js内で完結させる。
            await interaction.editReply({ content: `❌ VCへの接続に失敗しました。` });
        }
    },
};