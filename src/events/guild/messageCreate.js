const { Events } = require('discord.js');
const { applyDictionary } = require('../../utils/dictionaryProcessor');

const MAX_READ_LENGTH = parseInt(process.env.MAX_READ_LENGTH, 10) || 100;

module.exports = {
    name: Events.MessageCreate,
    async execute(message, client) {
        if (message.author.bot || !message.guildId) return; 
        
        const manager = client.guildVoiceManagers.get(message.guildId);
        
        // マネージャーがない、またはBotがVCにいない場合は無視
        if (!manager || !manager.isActive()) return;
        
        // 読み上げ先が未定(null)の場合の自動バインド処理
        if (!manager.getTextChannelId()) {
            const voiceChannel = manager.getVoiceChannel();
            if (message.member && message.member.voice.channelId === voiceChannel.id) {
                manager.setTextChannelId(message.channel.id);
                
                await message.channel.send(
                    `✅ **読み上げを開始します**\n` +
                    `自動接続後、最初に発言があったこのチャンネル (${message.channel.name}) を読み上げ対象に設定しました。\n` +
                    `💡 読み上げ場所を変更したい場合は、変更先のチャンネルで \`/join\` を実行してください。`
                );
                // 接続ログはvoiceManagerで抑制されているため、ここでの個別ログはプライバシーのため削除します
                // console.log(`[${message.guildId}] テキストチャンネルを自動設定: ${message.channel.name}`);
            } else {
                return;
            }
        }
        
        if (message.channel.id !== manager.getTextChannelId()) return;
        
        let textToRead = '';
        let isText = false; 
        
        if (message.attachments.size > 0 && message.attachments.some(att => att.contentType?.startsWith('image/'))) {
            textToRead = '画像'; 
        } else if (message.content) {
            textToRead = message.content;
            
            // 1. カスタム絵文字コードを削除 (★ 追加)
            // 例: <a:custom_emoji:1234567890> を除去
            textToRead = textToRead.replace(/<a?:.+?:\d+>/g, '');

            // 2. URLを置換
            textToRead = textToRead.replace(/https?:\/\/\S+/gi, 'ユーアールエル');
            
            // 3. 辞書適用処理
            textToRead = applyDictionary(textToRead, message.guildId);
            
            isText = true; 
        }
        
        if (textToRead.trim().length === 0) return;
        
        if (isText && textToRead.length > MAX_READ_LENGTH) {
            textToRead = textToRead.substring(0, MAX_READ_LENGTH) + ' 以下省略';
        }
        
        manager.addQueue(textToRead, message.author.id);
    },
};