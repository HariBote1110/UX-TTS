const { Events } = require('discord.js');
const { VoiceConnectionManager } = require('../../voiceManager');
const { getGuildSettings, getIgnoreChannels, getUserSettings } = require('../../database');
const { replaceSlang } = require('../../utils/dictionaryProcessor');
const easterEggManager = require('../../utils/easterEggManager'); // ★イースターエッグ
const { createStatusEmbed } = require('../../utils/helpers');

module.exports = {
    name: Events.MessageCreate,
    async execute(message, client) {
        if (message.author.bot) return;
        if (!message.guild) return;

        // 1. 基本チェック
        const guildId = message.guild.id;
        const manager = client.guildVoiceManagers.get(guildId);

        // BotがVCに参加していない場合は無視
        if (!manager || !manager.isActive()) return;

        // ★修正: 読み上げ対象の判定ロジック
        let currentTextId = manager.getTextChannelId();

        // 読み上げ対象が「未定(null)」の場合の処理
        if (!currentTextId) {
            // 発言者がBotと同じVCにいるか確認
            const botVoiceChannel = manager.getVoiceChannel();
            const memberVoiceChannel = message.member?.voice?.channel;

            // 同じVCにいるユーザーの発言であれば、このテキストチャンネルをバインドする
            if (botVoiceChannel && memberVoiceChannel && botVoiceChannel.id === memberVoiceChannel.id) {
                manager.setTextChannelId(message.channel.id);
                currentTextId = message.channel.id;

                // バインド完了の通知（VC内チャットの可能性もあるため message.channel に送信）
                const embed = createStatusEmbed('success', `**読み上げを開始します**\nこのチャンネル (${message.channel.name}) を読み上げ対象に設定しました。`);
                message.channel.send({ embeds: [embed] }).catch(() => { });
            } else {
                // 関係ない場所での発言は無視
                return;
            }
        }

        // 読み上げ対象のテキストチャンネルでない場合は無視
        if (currentTextId !== message.channel.id) return;

        // 2. 設定チェック (除外チャンネルなど)
        const ignoreList = await getIgnoreChannels(guildId);
        if (ignoreList.includes(message.channel.id)) return;

        // 3. テキスト処理
        let text = message.content;

        // コマンドは読み上げない
        if (text.startsWith('!') || text.startsWith('/') || text.startsWith(';')) return;

        // --- メンションの置換処理 ---

        // (1) ユーザーメンション
        text = text.replace(/<@!?(\d+)>/g, (match, id) => {
            const member = message.guild.members.cache.get(id);
            if (member) return member.displayName;
            const user = message.mentions.users.get(id);
            if (user) return user.username;
            return "ユーザー";
        });

        // (2) ロールメンション
        text = text.replace(/<@&(\d+)>/g, (match, id) => {
            const role = message.guild.roles.cache.get(id);
            return role ? "@" + role.name : "@";
        });

        // (3) チャンネルメンション
        text = text.replace(/<#(\d+)>/g, (match, id) => {
            const channel = message.guild.channels.cache.get(id);
            return channel ? "#" + channel.name : "#チャンネル";
        });

        // (4) URL省略
        text = text.replace(/https?:\/\/\S+/g, 'ユーアールエル');

        // (5) カスタム絵文字削除
        text = text.replace(/<a?:(\w+):\d+>/g, '');

        // (6) ネタバレ防止
        text = text.replace(/\|\|.*?\|\|/g, '伏せ字');

        // (7) コードブロック削除
        text = text.replace(/```[\s\S]*?```/g, 'コードブロック');

        // ------------------------------------------------

        // ★ イースターエッグチェック（辞書処理より前に実施）
        // 辞書で展開される前の元テキストでマッチしたらそのまま使用
        const isEasterEgg = easterEggManager.findMatch(text, message.author.id);

        // 4. 辞書置換（イースターエッグがマッチしなかった場合のみ）
        if (!isEasterEgg && replaceSlang) {
            text = await replaceSlang(guildId, message.author.id, text);
        }

        // 空文字や短すぎる場合は無視
        if (!text || text.trim().length === 0) return;

        // 長すぎるメッセージはカット（イースターエッグはカットしない）
        if (!isEasterEgg && text.length > 100) {
            text = text.substring(0, 100) + "、以下略";
        }

        // 5. 読み上げキューに追加
        await manager.addQueue(text, message.author.id);
    },
};
