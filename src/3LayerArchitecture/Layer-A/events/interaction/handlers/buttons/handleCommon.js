const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, AttachmentBuilder, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const { createSpeakerUIPayload, OJT_SPEAKERS, createStatusMessage, createActiveSpeechPanelPayload } = require('../../../../utils/helpers');
const {
    getUserSettings,
    setUserActiveSpeech,
    getDictionaryEntries,
    getUserPersonalDictionaryEntries,
    setUserSpeakerId,
    setGuildDefaultSpeaker,
    resetGuildDefaultSpeaker,
    importDictionary,
    clearDictionary
} = require('../../../../database');

const { ITEMS_PER_PAGE, BOT_OWNER_ID } = process.env;
const itemsPerPage = parseInt(ITEMS_PER_PAGE, 10) || 25;

function hasConfigBack(interaction) {
    return interaction.message?.components?.some(row =>
        row.components?.some(c => c.customId === 'config_back_main')
    ) ?? false;
}

function parseSpeakerTargetToken(token) {
    const [scope, id] = String(token || '').split(':');
    if ((scope === 'user' || scope === 'guild') && id) {
        return { scope, id };
    }
    return { scope: 'user', id: String(token || '') };
}

function canEditSpeakerTarget(interaction, target) {
    const isAdmin = interaction.member.permissions.has(PermissionFlagsBits.Administrator) || interaction.user.id === BOT_OWNER_ID;
    if (target.scope === 'guild') return isAdmin;
    return target.id === interaction.user.id || isAdmin;
}

function describeSpeakerTarget(target) {
    return target.scope === 'guild' ? 'サーバー既定話者' : `<@${target.id}>`;
}

// インポートモード待機用の処理関数 (変更なし)
async function startImportCollector(interaction, guildId, mode) {
    const modeText = mode === 'replace' ? '🗑️ **完全置き換え**' : '➕ **追加・更新 (統合)**';
    const warning = mode === 'replace' ? '\n⚠️ **注意: 現在の辞書はすべて削除されます！**' : '';

    await interaction.update(createStatusMessage(
        'info',
        `**辞書のインポート** (${modeText})\n\nインポートしたい辞書ファイル（.json, .dict, .csv）を、このチャットに**1分以内に送信（アップロード）**してください。${warning}\n対応形式: UX TTS形式, VOICEROID読み上げbotなどの形式(JSON), Shovelなどの形式(CSV/UTF-16)`,
        { title: '📥 インポート待機中', components: [], flags: [MessageFlags.Ephemeral] }
    ));

    const filter = m => m.author.id === interaction.user.id && m.attachments.size > 0;
    const collector = interaction.channel.createMessageCollector({ filter, time: 60000, max: 1 });

    collector.on('collect', async m => {
        const attachment = m.attachments.first();
        const fileUrl = attachment.url;
        const fileName = attachment.name.toLowerCase();

        try {
            const response = await fetch(fileUrl);
            if (!response.ok) throw new Error('Download failed');

            const buffer = await response.arrayBuffer();
            let text = '';

            const u8 = new Uint8Array(buffer);
            if (u8.length >= 2 && u8[0] === 0xFF && u8[1] === 0xFE) {
                const decoder = new TextDecoder('utf-16le');
                text = decoder.decode(buffer);
            } else if (u8.length >= 2 && u8[0] === 0xFE && u8[1] === 0xFF) {
                const decoder = new TextDecoder('utf-16be');
                text = decoder.decode(buffer);
            } else {
                const decoder = new TextDecoder('utf-8');
                text = decoder.decode(buffer);
            }

            let importData = [];

            if (fileName.endsWith('.json')) {
                try {
                    const json = JSON.parse(text);
                    if (Array.isArray(json)) {
                        importData = json.map(item => ({ word: item.word, read: item.read }));
                    } else if (json.data && typeof json.data === 'object') {
                        importData = Object.entries(json.data).map(([word, read]) => ({ word, read }));
                    } else {
                        importData = Object.entries(json).map(([word, read]) => ({ word, read }));
                    }
                } catch (e) {
                    await interaction.followUp(createStatusMessage('error', 'JSONの解析に失敗しました。', { flags: [MessageFlags.Ephemeral] }));
                    return;
                }
            }
            else {
                const lines = text.split(/\r?\n/);
                for (const line of lines) {
                    if (!line.trim()) continue;
                    const parts = line.split(',');
                    if (parts.length >= 2) {
                        const word = parts[0].trim();
                        const read = parts.slice(1).join(',').trim();
                        if (word && read) {
                            importData.push({ word, read });
                        }
                    }
                }
            }

            if (importData.length === 0) {
                await interaction.followUp(createStatusMessage('warning', '有効な辞書データが見つかりませんでした。', { flags: [MessageFlags.Ephemeral] }));
                return;
            }

            if (mode === 'replace') {
                await clearDictionary(guildId);
            }

            const count = await importDictionary(guildId, importData);
            await interaction.followUp(createStatusMessage('success', `**${count}** 件の単語をインポートしました！ (${modeText})`, { flags: [MessageFlags.Ephemeral] }));

            if (m.deletable) m.delete().catch(e => {
                if (e.code !== 10008) console.error('[handleCommon] Failed to delete message:', e);
            });

        } catch (err) {
            console.error(err);
            await interaction.followUp(createStatusMessage('error', `インポート中にエラーが発生しました: ${err.message}`, { flags: [MessageFlags.Ephemeral] }));
        }
    });

    collector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            interaction.followUp(createStatusMessage('warning', '時間切れのためインポートをキャンセルしました。', { title: '⏱️ タイムアウト', flags: [MessageFlags.Ephemeral] }));
        }
    });
}


module.exports = async (interaction, client) => {
    const { customId, guildId } = interaction;

    // --- ActiveSpeech ---
    if (['activespeech_skip', 'activespeech_force', 'activespeech_disable', 'activespeech_enable'].includes(customId)) {
        const manager = client.guildVoiceManagers.get(guildId);

        if (customId === 'activespeech_enable') {
            await setUserActiveSpeech(guildId, interaction.user.id, true);
            if (manager && manager.isActive()) manager.updateSelfDeaf();
            const hasBack = interaction.message?.components?.some(row =>
                row.components?.some(c => c.customId === 'config_back_main')
            );
            await interaction.update(createActiveSpeechPanelPayload(true, { showBack: hasBack }));
            return true;
        }

        if (customId === 'activespeech_disable') {
            await setUserActiveSpeech(guildId, interaction.user.id, false);
            if (manager) manager.forcePlayCurrent();
            const hasBack = interaction.message?.components?.some(row =>
                row.components?.some(c => c.customId === 'config_back_main')
            );
            await interaction.update(createActiveSpeechPanelPayload(false, { showBack: hasBack }));
            return true;
        }

        if (!manager) return interaction.reply(createStatusMessage('warning', '音声接続が見つかりません。', { flags: [MessageFlags.Ephemeral] }));

        if (customId === 'activespeech_skip') {
            manager.skipCurrent();
            await interaction.reply(createStatusMessage('success', 'スキップしました。', { title: '⏭️ 操作完了', flags: [MessageFlags.Ephemeral] }));
        } else if (customId === 'activespeech_force') {
            manager.forcePlayCurrent();
            await interaction.reply(createStatusMessage('success', '強制再生します。', { title: '▶️ 操作完了', flags: [MessageFlags.Ephemeral] }));
        }
        return true;
    }

    // --- 辞書エクスポート ---
    if (customId === 'dict_export_file') {
        const entries = await getDictionaryEntries(guildId);
        if (entries.length === 0) {
            await interaction.reply(createStatusMessage('warning', '辞書にデータが登録されていません。', { flags: [MessageFlags.Ephemeral] }));
            return true;
        }

        const embed = new EmbedBuilder()
            .setTitle('📤 辞書エクスポート')
            .setDescription('エクスポートするファイル形式を選択してください。')
            .setColor(0x00AAFF);

        const select = new StringSelectMenuBuilder()
            .setCustomId('dict_export_format_select')
            .setPlaceholder('形式を選択...')
            .addOptions([
                { label: 'UX TTS形式 (推奨)', description: 'バックアップ・移行用 (.json)', value: 'uxtts', emoji: '📦' },
                { label: 'VOICEROID読み上げbotなどの形式', description: '互換用JSON (.json)', value: 'voiceroid', emoji: '🔄' },
                { label: 'Shovelなどの形式', description: 'CSV/Dict形式 (UTF-16LE)', value: 'shovel', emoji: '📝' },
            ]);

        const row = new ActionRowBuilder().addComponents(select);
        await interaction.reply({ embeds: [embed], components: [row], flags: [MessageFlags.Ephemeral] });
        return true;
    }

    // --- 辞書インポート ---
    else if (customId === 'dict_import_start') {
        const embed = new EmbedBuilder()
            .setTitle('📥 辞書インポートモード選択')
            .setDescription('インポートの方法を選択してください。')
            .setColor(0x00AAFF);

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('dict_import_mode_merge').setLabel('追加・更新 (統合)').setStyle(ButtonStyle.Success).setEmoji('➕'),
            new ButtonBuilder().setCustomId('dict_import_mode_replace').setLabel('全て消去して登録 (置き換え)').setStyle(ButtonStyle.Danger).setEmoji('🗑️')
        );

        await interaction.reply({ embeds: [embed], components: [row], flags: [MessageFlags.Ephemeral] });
        return true;
    }
    else if (customId === 'dict_import_mode_merge') {
        await startImportCollector(interaction, guildId, 'merge');
        return true;
    }
    else if (customId === 'dict_import_mode_replace') {
        await startImportCollector(interaction, guildId, 'replace');
        return true;
    }

    // --- Dictionary (既存) ---
    if (customId === 'dict_add_modal_open') {
        const modal = new ModalBuilder().setCustomId('dict_add_modal_submit').setTitle('辞書登録 / 編集');
        const wordInput = new TextInputBuilder().setCustomId('dict_word').setLabel("登録する単語").setStyle(TextInputStyle.Short).setPlaceholder('例: Hello').setRequired(true);
        const readInput = new TextInputBuilder().setCustomId('dict_read').setLabel("読み方").setStyle(TextInputStyle.Short).setPlaceholder('例: ハロー').setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(wordInput), new ActionRowBuilder().addComponents(readInput));
        await interaction.showModal(modal);
        return true;
    }
    else if (customId === 'dict_delete_menu_open' || customId.startsWith('dict_delete_page_')) {
        const entries = await getDictionaryEntries(guildId);
        if (entries.length === 0) {
            const payload = createStatusMessage('warning', '削除できる単語がありません。', { flags: [MessageFlags.Ephemeral], components: [] });
            if (customId.startsWith('dict_delete_page_')) return interaction.update(payload);
            else return interaction.reply(payload);
        }

        let page = 1;
        if (customId.startsWith('dict_delete_page_')) {
            page = parseInt(customId.split('_')[3], 10) || 1;
        }

        const totalPages = Math.ceil(entries.length / itemsPerPage);
        page = Math.max(1, Math.min(page, totalPages));
        const startIndex = (page - 1) * itemsPerPage;
        const endIndex = startIndex + itemsPerPage;
        const options = entries.slice(startIndex, endIndex).map(entry => ({
            label: entry.word.substring(0, 100),
            description: entry.read_as.substring(0, 100),
            value: entry.word.substring(0, 100)
        }));

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('dict_delete_menu_selected')
            .setPlaceholder(`削除する単語を選択 (ページ ${page}/${totalPages})`)
            .setMinValues(1).setMaxValues(options.length).addOptions(options);

        const menuRow = new ActionRowBuilder().addComponents(selectMenu);
        const buttonRow = new ActionRowBuilder();
        const prevButton = new ButtonBuilder().setCustomId(`dict_delete_page_${page - 1}`).setLabel('◀ 前へ').setStyle(ButtonStyle.Secondary).setDisabled(page === 1);
        const nextButton = new ButtonBuilder().setCustomId(`dict_delete_page_${page + 1}`).setLabel('次へ ▶').setStyle(ButtonStyle.Secondary).setDisabled(page === totalPages);
        buttonRow.addComponents(prevButton, nextButton);

        const content = `削除したい単語を選択してください。（全${entries.length}件中 ${startIndex + 1}〜${Math.min(endIndex, entries.length)}件を表示）`;
        const payload = createStatusMessage('info', content, { components: [menuRow, buttonRow], flags: [MessageFlags.Ephemeral] });

        if (customId.startsWith('dict_delete_page_')) await interaction.update(payload);
        else await interaction.reply(payload);
        return true;
    }
    else if (customId === 'dict_delete_modal_open') {
        const modal = new ModalBuilder().setCustomId('dict_delete_modal_submit').setTitle('辞書から削除');
        const wordInput = new TextInputBuilder().setCustomId('dict_delete_word').setLabel("削除する単語を入力").setStyle(TextInputStyle.Short).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(wordInput));
        await interaction.showModal(modal);
        return true;
    }
    else if (customId === 'dict_list_show') {
        const entries = await getDictionaryEntries(guildId);
        if (entries.length === 0) return interaction.reply(createStatusMessage('info', '辞書にはまだ何も登録されていません。', { title: '📖 辞書', flags: [MessageFlags.Ephemeral] }));
        const listString = entries.map(e => `・**${e.word}** → ${e.read_as}`).join('\n');
        const embed = new EmbedBuilder().setTitle('📖 辞書一覧').setDescription(listString.length > 4000 ? listString.substring(0, 4000) + '...' : listString).setColor(0x00AAFF);
        await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
        return true;
    }

    // --- マイ辞書（ユーザー個人・最大10語） ---
    else if (customId === 'user_dict_add_modal_open') {
        const modal = new ModalBuilder().setCustomId('user_dict_add_modal_submit').setTitle('辞書登録 / 編集');
        const wordInput = new TextInputBuilder().setCustomId('user_dict_word').setLabel("登録する単語").setStyle(TextInputStyle.Short).setPlaceholder('例: Hello').setRequired(true);
        const readInput = new TextInputBuilder().setCustomId('user_dict_read').setLabel("読み方").setStyle(TextInputStyle.Short).setPlaceholder('例: ハロー').setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(wordInput), new ActionRowBuilder().addComponents(readInput));
        await interaction.showModal(modal);
        return true;
    }
    else if (customId === 'user_dict_delete_menu_open' || customId.startsWith('user_dict_delete_page_')) {
        const userId = interaction.user.id;
        const entries = await getUserPersonalDictionaryEntries(userId);
        if (entries.length === 0) {
            const payload = createStatusMessage('warning', '削除できる単語がありません。', { flags: [MessageFlags.Ephemeral], components: [] });
            if (customId.startsWith('user_dict_delete_page_')) return interaction.update(payload);
            return interaction.reply(payload);
        }

        let page = 1;
        if (customId.startsWith('user_dict_delete_page_')) {
            page = parseInt(customId.replace('user_dict_delete_page_', ''), 10) || 1;
        }

        const totalPages = Math.ceil(entries.length / itemsPerPage);
        page = Math.max(1, Math.min(page, totalPages));
        const startIndex = (page - 1) * itemsPerPage;
        const endIndex = startIndex + itemsPerPage;
        const options = entries.slice(startIndex, endIndex).map((entry) => ({
            label: entry.word.substring(0, 100),
            description: (entry.read_as || '').substring(0, 100),
            value: String(entry.id)
        }));

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId('user_dict_delete_menu_selected')
            .setPlaceholder(`削除する単語を選択 (ページ ${page}/${totalPages})`)
            .setMinValues(1)
            .setMaxValues(options.length)
            .addOptions(options);

        const menuRow = new ActionRowBuilder().addComponents(selectMenu);
        const buttonRow = new ActionRowBuilder();
        const prevButton = new ButtonBuilder().setCustomId(`user_dict_delete_page_${page - 1}`).setLabel('◀ 前へ').setStyle(ButtonStyle.Secondary).setDisabled(page === 1);
        const nextButton = new ButtonBuilder().setCustomId(`user_dict_delete_page_${page + 1}`).setLabel('次へ ▶').setStyle(ButtonStyle.Secondary).setDisabled(page === totalPages);
        buttonRow.addComponents(prevButton, nextButton);

        const content = `削除したい単語を選択してください。（全${entries.length}件中 ${startIndex + 1}〜${Math.min(endIndex, entries.length)}件を表示）`;
        const payload = createStatusMessage('info', content, { components: [menuRow, buttonRow], flags: [MessageFlags.Ephemeral] });

        if (customId.startsWith('user_dict_delete_page_')) await interaction.update(payload);
        else await interaction.reply(payload);
        return true;
    }
    else if (customId === 'user_dict_delete_modal_open') {
        const modal = new ModalBuilder().setCustomId('user_dict_delete_modal_submit').setTitle('辞書から削除');
        const wordInput = new TextInputBuilder().setCustomId('user_dict_delete_word').setLabel("削除する単語を入力").setStyle(TextInputStyle.Short).setRequired(true);
        modal.addComponents(new ActionRowBuilder().addComponents(wordInput));
        await interaction.showModal(modal);
        return true;
    }
    else if (customId === 'user_dict_list_show') {
        const entries = await getUserPersonalDictionaryEntries(interaction.user.id);
        if (entries.length === 0) {
            return interaction.reply(createStatusMessage('info', '辞書にはまだ何も登録されていません。', { title: '📖 辞書', flags: [MessageFlags.Ephemeral] }));
        }
        const listString = entries.map((e) => `・**${e.word}** → ${e.read_as}`).join('\n');
        const embed = new EmbedBuilder()
            .setTitle('📖 辞書一覧')
            .setDescription(listString.length > 4000 ? listString.substring(0, 4000) + '...' : listString)
            .setColor(0x00AAFF)
            .setFooter({ text: `マイ辞書 ${entries.length}/10` });
        await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
        return true;
    }

    // ==========================================
    // 話者設定: ターゲット切り替え / リセット
    // ==========================================
    else if (customId.startsWith('speaker_scope_switch_guild_')) {
        const parts = customId.split('_');
        const type = parts[4] || 'voicevox';
        const targetGuildId = parts[5] || guildId;
        const target = { scope: 'guild', id: targetGuildId };

        if (!canEditSpeakerTarget(interaction, target)) {
            return interaction.reply(createStatusMessage('error', 'サーバー既定を変更する権限がありません。', { flags: [MessageFlags.Ephemeral] }));
        }

        await interaction.update(await createSpeakerUIPayload(client, 1, targetGuildId, type, interaction.member, 'guild', hasConfigBack(interaction)));
        return true;
    }
    else if (customId.startsWith('speaker_scope_switch_user_')) {
        const parts = customId.split('_');
        const type = parts[4] || 'voicevox';
        const targetUserId = parts[5] || interaction.user.id;
        const target = { scope: 'user', id: targetUserId };

        if (!canEditSpeakerTarget(interaction, target)) {
            return interaction.reply(createStatusMessage('error', '個人設定を変更する権限がありません。', { flags: [MessageFlags.Ephemeral] }));
        }

        await interaction.update(await createSpeakerUIPayload(client, 1, targetUserId, type, interaction.member, 'user', hasConfigBack(interaction)));
        return true;
    }
    else if (customId.startsWith('speaker_guild_default_reset_')) {
        const parts = customId.split('_');
        const targetToken = parts[4];
        const type = parts[5] || 'voicevox';
        const target = parseSpeakerTargetToken(targetToken);

        if (target.scope !== 'guild') {
            return interaction.reply(createStatusMessage('error', 'この操作はサーバー既定モードでのみ利用できます。', { flags: [MessageFlags.Ephemeral] }));
        }
        if (!canEditSpeakerTarget(interaction, target)) {
            return interaction.reply(createStatusMessage('error', 'サーバー既定を変更する権限がありません。', { flags: [MessageFlags.Ephemeral] }));
        }

        await resetGuildDefaultSpeaker(guildId);
        await interaction.update(createStatusMessage(
            'success',
            'サーバー既定話者をリセットしました。個人設定が未設定のユーザーは環境既定話者が使用されます。',
            {
                components: [
                    new ActionRowBuilder().addComponents(
                        new ButtonBuilder()
                            .setCustomId(`speaker_scope_switch_guild_${type}_${guildId}`)
                            .setLabel('話者を選び直す')
                            .setStyle(ButtonStyle.Secondary)
                    )
                ]
            }
        ));
        return true;
    }

    // ==========================================
    // ランダム話者設定
    // ==========================================
    else if (customId.startsWith('speaker_random_')) {
        const parts = customId.split('_');
        const targetToken = parts[2];
        const type = parts[3];
        const target = parseSpeakerTargetToken(targetToken);

        if (!canEditSpeakerTarget(interaction, target)) {
            return interaction.reply(createStatusMessage('error', 'この設定を変更する権限がありません。', { flags: [MessageFlags.Ephemeral] }));
        }

        const speakerList = (type === 'ojt') ? OJT_SPEAKERS : client.speakerCache;
        if (!speakerList || speakerList.length === 0) return interaction.reply(createStatusMessage('warning', '話者リストが取得できません。', { flags: [MessageFlags.Ephemeral] }));

        const randomSpeaker = speakerList[Math.floor(Math.random() * speakerList.length)];
        const randomStyle = randomSpeaker.styles[Math.floor(Math.random() * randomSpeaker.styles.length)];

        if (target.scope === 'guild') {
            await setGuildDefaultSpeaker(guildId, randomStyle.id, type);
        } else {
            await setUserSpeakerId(guildId, target.id, randomStyle.id, type);
        }

        await interaction.update(createStatusMessage('success', `🎲 ${describeSpeakerTarget(target)} を **${randomSpeaker.name}** (${randomStyle.name}) に設定しました！`, { components: [] }));
        return true;
    }

    // --- Speaker (Pagination / Switch / Confirm) ---
    else if (customId.startsWith('speaker_page_') || customId.startsWith('back_to_charlist_page_')) {
        const parts = customId.split('_');
        const type = parts[parts.length - 1];
        const targetToken = parts[parts.length - 2];
        const page = parseInt(parts[parts.length - 3], 10);
        const target = parseSpeakerTargetToken(targetToken);

        if (!canEditSpeakerTarget(interaction, target)) {
            return interaction.reply(createStatusMessage('error', 'この設定メニューを操作する権限がありません。', { flags: [MessageFlags.Ephemeral] }));
        }

        await interaction.update(await createSpeakerUIPayload(client, page, target.id, type, interaction.member, target.scope, hasConfigBack(interaction)));
        return true;
    }
    else if (customId.startsWith('speaker_type_switch_')) {
        const parts = customId.split('_');
        const targetType = parts[3];
        const targetToken = parts[4];
        const target = parseSpeakerTargetToken(targetToken);

        if (!canEditSpeakerTarget(interaction, target)) {
            return interaction.reply(createStatusMessage('error', 'この設定メニューを操作する権限がありません。', { flags: [MessageFlags.Ephemeral] }));
        }

        await interaction.update(await createSpeakerUIPayload(client, 1, target.id, targetType, interaction.member, target.scope, hasConfigBack(interaction)));
        return true;
    }
    else if (customId.startsWith('confirm_style_')) {
        const parts = customId.split('_');
        const compactFormat = parts.length >= 5 && String(parts[3] || '').includes(':');
        const type = compactFormat ? (parts[4] || 'voicevox') : (parts[parts.length - 1] || 'voicevox');
        const targetTokenRaw = compactFormat ? (parts[3] || '') : (parts[parts.length - 2] || '');
        const targetToken = targetTokenRaw.includes(':') ? targetTokenRaw : `user:${targetTokenRaw}`;
        const target = parseSpeakerTargetToken(targetToken);

        if (!canEditSpeakerTarget(interaction, target)) {
            return interaction.reply(createStatusMessage('error', 'この設定メニューを操作する権限がありません。', { flags: [MessageFlags.Ephemeral] }));
        }

        const speakerId = parseInt(parts[2], 10);
        const speakerList = (type === 'ojt') ? OJT_SPEAKERS : client.speakerCache;
        const speakerName = compactFormat
            ? (speakerList.find(speaker => Array.isArray(speaker.styles) && speaker.styles.some(style => style.id === speakerId))?.name || '不明')
            : (speakerList.find(s => s.speaker_uuid === parts[3])?.name || parts[3] || '不明');

        if (Number.isNaN(speakerId)) {
            return interaction.reply(createStatusMessage('error', '話者設定に失敗しました（speakerIdが不正です）。', { flags: [MessageFlags.Ephemeral] }));
        }

        if (target.scope === 'guild') {
            await setGuildDefaultSpeaker(guildId, speakerId, type);
        } else {
            await setUserSpeakerId(guildId, target.id, speakerId, type);
        }

        await interaction.update(createStatusMessage('success', `${describeSpeakerTarget(target)} を **${speakerName}** (${type === 'ojt' ? 'Open JTalk' : 'VOICEVOX'}) に設定しました。`, { components: [] }));
        return true;
    }

    // --- リセット設定確認 ---
    if (customId === 'reset_settings_confirm_yes') {
        const manager = client.guildVoiceManagers.get(guildId);
        if (!manager || !manager.isActive()) {
            await interaction.update(createStatusMessage('warning', 'Botが既にボイスチャンネルから切断されています。リセットをキャンセルしました。', { components: [] }));
            return true;
        }
        manager.resetSettings(interaction.user.id);
        await interaction.update(createStatusMessage('success', 'あなたの話者・話速・ピッチをデフォルトに戻しました。', { components: [] }));
        return true;
    }

    if (customId === 'reset_settings_confirm_no') {
        await interaction.update(createStatusMessage('info', 'リセットをキャンセルしました。', { components: [] }));
        return true;
    }

    return false;
};
