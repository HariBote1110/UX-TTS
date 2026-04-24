const { Events, ChannelType, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const { VoiceConnectionManager } = require('../../voiceManager');
const { 
    getUserSettings, 
    getGuildSettings, 
    getIgnoreChannels, 
    getAllowChannels, 
    getChannelPair,
    getAutoVCGenerator, addActiveChannel, getActiveChannel, removeActiveChannel 
} = require('../../database');
const { updateActivity, getAnnouncement } = require('../../utils/helpers');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

module.exports = {
    name: Events.VoiceStateUpdate,
    async execute(oldState, newState, client) {
        const guildId = newState.guild.id;
        if (!newState.member) return;
        const userId = newState.member.id;
        
        const isBot = (userId === client.user.id);

        const manager = client.guildVoiceManagers.get(guildId);
        const isBotConnected = manager && manager.isActive();

        // ==========================================
        // 1. 自動接続 (Auto Join)
        // ==========================================
        if (!isBot && newState.channelId && newState.channelId !== oldState.channelId) {
            const targetChannel = newState.channel;
            let shouldJoin = false;
            let joinReason = '';

            const userSettings = getUserSettings(guildId, userId);
            if (userSettings.auto_join === 1) {
                shouldJoin = true;
                joinReason = 'user_follow';
            } else if (!isBotConnected) {
                const guildSettings = getGuildSettings(guildId);
                if (guildSettings.auto_join_enabled === 1) {
                    shouldJoin = true;
                    joinReason = 'server_auto';
                }
            }

            if (shouldJoin && targetChannel.joinable && targetChannel.speakable) {
                const allowList = getAllowChannels(guildId);
                const ignoreList = getIgnoreChannels(guildId);
                let isTarget = false;

                if (allowList.length > 0) {
                    if (allowList.includes(targetChannel.id)) isTarget = true;
                } else {
                    if (!ignoreList.includes(targetChannel.id)) isTarget = true;
                }

                if (isTarget) {
                    let targetManager = manager;
                    if (!targetManager) {
                        targetManager = new VoiceConnectionManager(client, guildId);
                        client.guildVoiceManagers.set(guildId, targetManager);
                    }
                    
                    let bindTextChannelId = targetManager.getTextChannelId();
                    const pair = getChannelPair(guildId, targetChannel.id);
                    if (pair) bindTextChannelId = pair.text_channel_id;
                    
                    const success = await targetManager.connect(targetChannel, bindTextChannelId); 
                    if (success) {
                        await updateActivity(client);
                        if (pair && bindTextChannelId) {
                            const tc = client.channels.cache.get(bindTextChannelId);
                            if (tc && tc.isTextBased()) {
                                const news = getAnnouncement();
                                let msg = `✅ **自動接続しました**\n🔊 ${targetChannel.name} に参加し、このチャンネルを読み上げ対象に設定しました。`;
                                if (news.enabled && news.vc_suffix) msg += news.vc_suffix;
                                tc.send(msg).catch(() => {});
                            }
                        }
                    }
                }
            }
        }

        // ==========================================
        // 2. 自動切断 & ActiveSpeech
        // ==========================================
        if (isBotConnected) {
            const currentBotChannel = manager.getVoiceChannel(); 
            if (currentBotChannel) {
                const guildSettings = getGuildSettings(guildId);
                const channel = client.channels.cache.get(currentBotChannel.id);
                
                if (channel && channel.isVoiceBased()) {
                    const isEventInBotChannel = (oldState.channelId === currentBotChannel.id || newState.channelId === currentBotChannel.id);
                    if (isEventInBotChannel) {
                        const humanCount = channel.members.filter(member => !member.user.bot).size;
                        if (humanCount === 0) {
                            manager.disconnect(true);
                        } else if (!isBot) {
                            const memberName = newState.member.displayName;
                            if (newState.channelId === currentBotChannel.id && oldState.channelId !== currentBotChannel.id) {
                                if (guildSettings.read_join === 1) manager.addQueue(`${memberName}さんが入室しました`, userId);
                            }
                            else if (oldState.channelId === currentBotChannel.id && newState.channelId !== currentBotChannel.id) {
                                if (guildSettings.read_leave === 1) manager.addQueue(`${memberName}さんが退出しました`, userId);
                            }
                        }
                    }
                    manager.updateSelfDeaf();
                }
            }
        }

        // ==========================================
        // 3. AutoVC (自動チャンネル作成)
        // ==========================================
        
        // A. チャンネル作成
        if (!isBot && newState.channelId && newState.channelId !== oldState.channelId) {
            const generator = getAutoVCGenerator(newState.guild.id, newState.channelId);
            
            if (generator) {
                const member = newState.member;
                const guild = newState.guild;

                try {
                    const channelName = generator.naming_pattern.replace('{user}', member.displayName);
                    const createdVoice = await guild.channels.create({
                        name: channelName,
                        type: ChannelType.GuildVoice,
                        parent: generator.category_id,
                        permissionOverwrites: [
                            { id: member.id, allow: [PermissionFlagsBits.ManageChannels, PermissionFlagsBits.Connect] },
                            { id: guild.roles.everyone, allow: [PermissionFlagsBits.Connect] }
                        ]
                    });

                    await member.voice.setChannel(createdVoice);

                    const embed = new EmbedBuilder()
                        .setTitle(`🎛️ ${channelName} コントロールパネル`)
                        .setDescription(`このチャンネルのオーナー: ${member}\nここ(VC内チャット)で会話や設定変更ができます。`)
                        .setColor(0x00AAFF);
                    
                    const row1 = new ActionRowBuilder().addComponents(
                        // ★ 追加: 読み上げ参加ボタン
                        new ButtonBuilder().setCustomId('autovc_join_bot').setLabel('読み上げ参加').setStyle(ButtonStyle.Success).setEmoji('🤖'),
                        new ButtonBuilder().setCustomId('autovc_rename').setLabel('名前変更').setStyle(ButtonStyle.Secondary).setEmoji('✏️'),
                        new ButtonBuilder().setCustomId('autovc_limit').setLabel('人数制限').setStyle(ButtonStyle.Secondary).setEmoji('👥'),
                        new ButtonBuilder().setCustomId('autovc_lock').setLabel('ロック/解除').setStyle(ButtonStyle.Danger).setEmoji('🔒')
                    );
                    
                    await createdVoice.send({ content: `${member} 専用チャンネルを作成しました。`, embeds: [embed], components: [row1] });

                    addActiveChannel(createdVoice.id, generator.text_channel_id, guild.id, member.id);

                } catch (e) {
                    console.error('AutoVC Create Error:', e);
                }
            }
        }

        // B. チャンネル削除 & アーカイブ処理
        if (oldState.channelId) {
            const activeInfo = getActiveChannel(oldState.channelId);
            if (activeInfo) {
                const channel = oldState.channel;
                if (channel && channel.members.size === 0) {
                    try {
                        let messages = [];
                        try {
                            const fetched = await channel.messages.fetch({ limit: 100 });
                            messages = Array.from(fetched.values()).reverse();
                        } catch (e) { console.log('VC Message Fetch Error:', e.message); }

                        if (activeInfo.archive_channel_id && messages.length > 0) {
                            const archiveParent = oldState.guild.channels.cache.get(activeInfo.archive_channel_id);
                            
                            if (archiveParent && archiveParent.isTextBased()) {
                                const dateStr = new Date().toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
                                const threadName = `📦 Log: ${channel.name} (${dateStr})`;
                                
                                const thread = await archiveParent.threads.create({
                                    name: threadName,
                                    autoArchiveDuration: 60,
                                    reason: 'AutoVC Session Archive'
                                });

                                let webhook;
                                try {
                                    const hooks = await archiveParent.fetchWebhooks();
                                    webhook = hooks.find(h => h.owner.id === client.user.id);
                                    if (!webhook) {
                                        webhook = await archiveParent.createWebhook({
                                            name: 'AutoVC Archiver',
                                            avatar: client.user.displayAvatarURL(),
                                        });
                                    }
                                } catch (whErr) {
                                    await thread.send('⚠️ Botに「ウェブフックの管理」権限がないため、チャットログを完全な形式で保存できませんでした。');
                                }

                                if (webhook) {
                                    await thread.send(`**${channel.name}** のチャットアーカイブを作成します...`);

                                    for (const m of messages) {
                                        if (m.author.bot) continue; 

                                        let content = m.content || '';
                                        if (m.attachments.size > 0) {
                                            const urls = m.attachments.map(a => a.url).join('\n');
                                            content += `\n${urls}`;
                                        }

                                        if (content.trim().length > 0) {
                                            await webhook.send({
                                                content: content,
                                                username: m.author.displayName || m.author.username,
                                                avatarURL: m.author.displayAvatarURL(),
                                                threadId: thread.id,
                                            });
                                            await sleep(800);
                                        }
                                    }
                                    
                                    await thread.send('*(アーカイブ完了・ロックします)*');
                                    await thread.setLocked(true);
                                    await thread.setArchived(true);
                                }
                            }
                        }

                        await channel.delete().catch(() => {});
                        removeActiveChannel(oldState.channelId);

                    } catch (e) {
                        console.error('AutoVC Delete/Archive Error:', e);
                    }
                }
            }
        }
    },
};