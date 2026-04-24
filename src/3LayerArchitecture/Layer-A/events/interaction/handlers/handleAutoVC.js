const {
    ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    StringSelectMenuBuilder, ChannelSelectMenuBuilder, ChannelType,
    PermissionFlagsBits, MessageFlags
} = require('discord.js');
const { 
    getActiveChannel, getAutoVCGenerators, 
    addAutoVCGenerator, removeAutoVCGenerator 
} = require('../../../database');
const { VoiceConnectionManager } = require('../../../voiceManager'); // ★ 追加
const { updateActivity, createAutoVCMenuPayload, createStatusMessage } = require('../../../utils/helpers'); // ★ 追加
const { BOT_OWNER_ID } = process.env;

module.exports = {
    // ボタン処理
    async handleButton(interaction) {
        const { customId, guild, user } = interaction;
        const canManageAutoVC = interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)
            || interaction.member.permissions.has(PermissionFlagsBits.Administrator)
            || user.id === BOT_OWNER_ID;

        // --- A. 設定パネル (Config) ---
        if (customId === 'autovc_config_refresh') {
            const showBack = interaction.message?.components?.some(row =>
                row.components?.some(c => c.customId === 'config_back_main')
            ) ?? false;
            const payload = await createAutoVCMenuPayload(guild, user.id, interaction.member.permissions, { showBack });
            await interaction.update(payload);
            return;
        }

        if (customId === 'autovc_config_add') {
            if (!canManageAutoVC) {
                await interaction.reply(createStatusMessage('error', 'この操作にはチャンネル管理権限が必要です。', { flags: [MessageFlags.Ephemeral] }));
                return;
            }

            const menu = new ChannelSelectMenuBuilder()
                .setCustomId('autovc_setup_trigger')
                .setPlaceholder('トリガーとなるボイスチャンネルを選択')
                .setChannelTypes(ChannelType.GuildVoice);
            
            await interaction.reply(createStatusMessage(
                'info',
                '**ステップ 1/4**: ユーザーが入室する「トリガー」となるボイスチャンネルを選択してください。',
                {
                    title: '🛠️ AutoVC セットアップ',
                    components: [new ActionRowBuilder().addComponents(menu)],
                    flags: [MessageFlags.Ephemeral]
                }
            ));
            return;
        }

        if (customId.startsWith('autovc_setup_skip_text_')) {
            if (!canManageAutoVC) {
                await interaction.reply(createStatusMessage('error', 'この操作にはチャンネル管理権限が必要です。', { flags: [MessageFlags.Ephemeral] }));
                return;
            }
            const parts = customId.split('_');
            const categoryId = parts.pop();
            const triggerId = parts.pop();

            const modal = new ModalBuilder()
                .setCustomId(`autovc_setup_finish_${triggerId}_${categoryId}_none`)
                .setTitle('AutoVC 最終設定');
            const input = new TextInputBuilder()
                .setCustomId('pattern')
                .setLabel('チャンネル名のパターン')
                .setPlaceholder('{user}の部屋')
                .setValue('{user}の部屋')
                .setStyle(TextInputStyle.Short)
                .setRequired(true);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            await interaction.showModal(modal);
            return;
        }

        if (customId === 'autovc_config_delete' || customId.startsWith('autovc_config_delete_page_')) {
            if (!canManageAutoVC) {
                await interaction.reply(createStatusMessage('error', 'この操作にはチャンネル管理権限が必要です。', { flags: [MessageFlags.Ephemeral] }));
                return;
            }

            const generators = await getAutoVCGenerators(guild.id);
            if (generators.length === 0) return interaction.reply(createStatusMessage('warning', '削除できる設定がありません。', { flags: [MessageFlags.Ephemeral] }));

            const itemsPerPage = 25;
            const page = customId.startsWith('autovc_config_delete_page_') ? (parseInt(customId.split('_').pop(), 10) || 1) : 1;
            const totalPages = Math.ceil(generators.length / itemsPerPage);
            const currentPage = Math.max(1, Math.min(page, totalPages));
            const startIndex = (currentPage - 1) * itemsPerPage;
            const options = generators.slice(startIndex, startIndex + itemsPerPage).map(g => {
                const ch = guild.channels.cache.get(g.channel_id);
                const cat = guild.channels.cache.get(g.category_id);
                return {
                    label: (ch ? ch.name : `Unknown (${g.channel_id})`).substring(0, 100),
                    value: g.channel_id,
                    description: `作成先: ${cat ? cat.name : '未設定'}`.substring(0, 100)
                };
            });

            const menu = new StringSelectMenuBuilder()
                .setCustomId('autovc_setup_delete_select')
                .setPlaceholder(`削除する設定を選択 (ページ ${currentPage}/${totalPages})`)
                .addOptions(options);

            const prevButton = new ButtonBuilder().setCustomId(`autovc_config_delete_page_${currentPage - 1}`).setLabel('◀ 前へ').setStyle(ButtonStyle.Secondary).setDisabled(currentPage === 1);
            const nextButton = new ButtonBuilder().setCustomId(`autovc_config_delete_page_${currentPage + 1}`).setLabel('次へ ▶').setStyle(ButtonStyle.Secondary).setDisabled(currentPage === totalPages);
            const buttonRow = new ActionRowBuilder().addComponents(prevButton, nextButton);

            const content = `削除する設定を選択してください。（全${generators.length}件中 ${startIndex + 1}〜${Math.min(startIndex + itemsPerPage, generators.length)}件を表示）`;
            const payload = createStatusMessage('info', content, {
                title: '🗑️ AutoVC 設定削除',
                components: [new ActionRowBuilder().addComponents(menu), buttonRow],
                flags: [MessageFlags.Ephemeral]
            });

            if (customId.startsWith('autovc_config_delete_page_')) await interaction.update(payload);
            else await interaction.reply(payload);
            return;
        }

        // --- B. チャンネル内コントロールパネル (Control) ---
        const vcInfo = await getActiveChannel(interaction.channelId);

        if (!vcInfo) {
            return interaction.reply(createStatusMessage('error', 'このパネルは無効になっているか、チャンネル情報が見つかりません。', { flags: [MessageFlags.Ephemeral] }));
        }

        // ★ 読み上げ参加ボタン以外はオーナーのみ操作可能にする
        if (customId !== 'autovc_join_bot' && vcInfo.owner_id !== user.id) {
            return interaction.reply(createStatusMessage('error', '操作権限がありません（オーナーのみ操作可能）', { flags: [MessageFlags.Ephemeral] }));
        }

        const voiceChannel = guild.channels.cache.get(vcInfo.voice_channel_id);
        if (!voiceChannel) return interaction.reply(createStatusMessage('error', 'ボイスチャンネルが見つかりません。', { flags: [MessageFlags.Ephemeral] }));

        // ★ Bot参加処理
        if (customId === 'autovc_join_bot') {
            let manager = interaction.client.guildVoiceManagers.get(guild.id);
            if (!manager) {
                manager = new VoiceConnectionManager(interaction.client, guild.id);
                interaction.client.guildVoiceManagers.set(guild.id, manager);
            }
            
            // 接続 & 読み上げ対象をこのチャンネル(VC内チャット)に設定
            const success = await manager.connect(voiceChannel, voiceChannel.id);
            
            if (success) {
                await interaction.reply(createStatusMessage('success', '読み上げを開始しました。', { flags: [MessageFlags.Ephemeral] }));
                await updateActivity(interaction.client);
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
                    await interaction.reply(createStatusMessage(
                        'info',
                        `**${voiceChannel.name}** は現在別のBotが担当中です。\n「別のBotを割り当てる」で空いているBotを呼び出せます。`,
                        { title: '🤖 Bot割り当て', components: [assignRow], flags: [MessageFlags.Ephemeral] }
                    ));
                } else {
                    await interaction.reply(createStatusMessage('error', '接続に失敗しました。', { flags: [MessageFlags.Ephemeral] }));
                }
            }
            return;
        }

        if (customId === 'autovc_rename') {
            const modal = new ModalBuilder()
                .setCustomId(`autovc_rename_submit_${voiceChannel.id}`)
                .setTitle('チャンネル名変更');
            const input = new TextInputBuilder()
                .setCustomId('new_name')
                .setLabel('新しい名前')
                .setStyle(TextInputStyle.Short)
                .setValue(voiceChannel.name)
                .setMaxLength(100);
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            await interaction.showModal(modal);
        }
        else if (customId === 'autovc_limit') {
            const menu = new StringSelectMenuBuilder()
                .setCustomId(`autovc_limit_select_${voiceChannel.id}`)
                .setPlaceholder('人数制限を選択')
                .addOptions(
                    { label: '無制限 (0)', value: '0' },
                    { label: '1人', value: '1' },
                    { label: '2人', value: '2' },
                    { label: '3人', value: '3' },
                    { label: '4人', value: '4' },
                    { label: '5人', value: '5' },
                    { label: '6人', value: '6' },
                    { label: '7人', value: '7' },
                    { label: '8人', value: '8' },
                    { label: '9人', value: '9' },
                    { label: '10人', value: '10' },
                    { label: '12人', value: '12' },
                    { label: '15人', value: '15' },
                    { label: '20人', value: '20' },
                    { label: '30人', value: '30' },
                    { label: '50人', value: '50' },
                    { label: '99人', value: '99' }
                );
            await interaction.reply(createStatusMessage(
                'info',
                '人数制限を選択してください。',
                { components: [new ActionRowBuilder().addComponents(menu)], flags: [MessageFlags.Ephemeral] }
            ));
        }
        else if (customId === 'autovc_lock') {
            const current = voiceChannel.permissionsFor(guild.roles.everyone).has(PermissionFlagsBits.Connect);
            const newStatus = !current;
            await voiceChannel.permissionOverwrites.edit(guild.roles.everyone, { Connect: newStatus });
            await interaction.reply(createStatusMessage('success', `チャンネルを${newStatus ? 'ロック解除' : 'ロック'}しました。`, { flags: [MessageFlags.Ephemeral] }));
        }
    },

    // モーダル処理
    async handleModal(interaction) {
        if (interaction.customId.startsWith('autovc_rename_submit_')) {
            const vcId = interaction.customId.split('_').pop();
            const newName = interaction.fields.getTextInputValue('new_name');
            const channel = interaction.guild.channels.cache.get(vcId);
            if (channel) {
                await channel.setName(newName);
                await interaction.reply(createStatusMessage('success', `チャンネル名を **${newName}** に変更しました。`, { flags: [MessageFlags.Ephemeral] }));
            } else {
                await interaction.reply(createStatusMessage('error', 'チャンネルが見つかりませんでした。', { flags: [MessageFlags.Ephemeral] }));
            }
        }
        else if (interaction.customId.startsWith('autovc_setup_finish_')) {
            const parts = interaction.customId.split('_');
            const textId = parts.pop();
            const catId = parts.pop();
            const trigId = parts.pop();
            const pattern = interaction.fields.getTextInputValue('pattern') || '{user}の部屋';

            const logChannelId = textId === 'none' ? null : textId;
            await addAutoVCGenerator(interaction.guild.id, trigId, catId, logChannelId, pattern);

            const logLine = logChannelId ? `📝 ログ保存: <#${logChannelId}>` : '📝 ログ保存: なし（スキップ）';
            await interaction.update(createStatusMessage(
                'success',
                `**設定完了！**\n以下の設定でAutoVCを有効化しました。\n\n🎤 トリガー: <#${trigId}>\n📂 カテゴリ: <#${catId}>\n${logLine}\n🏷️ 命名: \`${pattern}\``,
                { components: [] }
            ));
        }
    },
    
    // セレクトメニュー処理
    async handleSelect(interaction) {
        const { customId, values } = interaction;

        if (customId.startsWith('autovc_limit_select_')) {
            const vcId = customId.split('_').pop();
            const limit = parseInt(values[0], 10);
            const channel = interaction.guild.channels.cache.get(vcId);
            if (channel) {
                await channel.setUserLimit(limit);
                await interaction.update(createStatusMessage('success', `人数制限を **${limit === 0 ? '無制限' : limit + '人'}** に設定しました。`, { components: [] }));
            } else {
                 await interaction.reply(createStatusMessage('error', 'チャンネルが見つかりませんでした。', { flags: [MessageFlags.Ephemeral] }));
            }
        }

        else if (customId === 'autovc_setup_delete_select') {
            const targetId = values[0];
            await removeAutoVCGenerator(interaction.guild.id, targetId);
            await interaction.update(createStatusMessage('success', '設定を削除しました。', { components: [] }));
        }

        else if (customId === 'autovc_setup_trigger') {
            const triggerId = values[0];
            const menu = new ChannelSelectMenuBuilder()
                .setCustomId(`autovc_setup_category_${triggerId}`)
                .setPlaceholder('作成先カテゴリを選択')
                .setChannelTypes(ChannelType.GuildCategory);
            
            await interaction.update(createStatusMessage(
                'info',
                '**ステップ 2/4**: 自動作成されたチャンネルを配置する「カテゴリ」を選択してください。',
                {
                    title: '🛠️ AutoVC セットアップ',
                    components: [new ActionRowBuilder().addComponents(menu)]
                }
            ));
        }

        else if (customId.startsWith('autovc_setup_category_')) {
            const triggerId = customId.split('_').pop();
            const categoryId = values[0];

            const menu = new ChannelSelectMenuBuilder()
                .setCustomId(`autovc_setup_text_${triggerId}_${categoryId}`)
                .setPlaceholder('チャットログ保存先を選択')
                .setChannelTypes(ChannelType.GuildText);
            const skipButton = new ButtonBuilder()
                .setCustomId(`autovc_setup_skip_text_${triggerId}_${categoryId}`)
                .setLabel('スキップ（ログなし）')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('⏭️');

            await interaction.update(createStatusMessage(
                'info',
                '**ステップ 3/4**: チャットログをアーカイブする先の「テキストチャンネル」を選択してください。\n不要な場合は「スキップ」を選択してください。',
                {
                    title: '🛠️ AutoVC セットアップ',
                    components: [
                        new ActionRowBuilder().addComponents(menu),
                        new ActionRowBuilder().addComponents(skipButton)
                    ]
                }
            ));
        }

        else if (customId.startsWith('autovc_setup_text_')) {
            const parts = customId.split('_');
            const categoryId = parts.pop();
            const triggerId = parts.pop();
            const textId = values[0];

            const modal = new ModalBuilder()
                .setCustomId(`autovc_setup_finish_${triggerId}_${categoryId}_${textId}`)
                .setTitle('AutoVC 最終設定');
            
            const input = new TextInputBuilder()
                .setCustomId('pattern')
                .setLabel('チャンネル名のパターン')
                .setPlaceholder('{user}の部屋')
                .setValue('{user}の部屋')
                .setStyle(TextInputStyle.Short)
                .setRequired(true);
            
            modal.addComponents(new ActionRowBuilder().addComponents(input));
            await interaction.showModal(modal);
        }
    }
};
