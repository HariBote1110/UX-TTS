const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, AttachmentBuilder, EmbedBuilder } = require('discord.js');
const { createSpeakerUIPayload } = require('../../../../utils/helpers');
const { 
    getUserSettings, setUserActiveSpeech, getDictionaryEntries, setUserSpeakerId, importDictionary, clearDictionary
} = require('../../../../database');

const { ITEMS_PER_PAGE } = process.env;
const itemsPerPage = parseInt(ITEMS_PER_PAGE, 10) || 25;

// インポートモード待機用の処理関数
async function startImportCollector(interaction, guildId, mode) {
    const modeText = mode === 'replace' ? '🗑️ **完全置き換え**' : '➕ **追加・更新 (統合)**';
    const warning = mode === 'replace' ? '\n⚠️ **注意: 現在の辞書はすべて削除されます！**' : '';

    await interaction.update({ 
        content: `📥 **辞書のインポート** (${modeText})\n\nインポートしたい辞書ファイル（.json, .dict, .csv）を、このチャットに**1分以内に送信（アップロード）**してください。${warning}\n対応形式: UX TTS形式, VOICEROID読み上げbotなどの形式(JSON), Shovelなどの形式(CSV/UTF-16)`,
        components: [],
        embeds: [],
        flags: [MessageFlags.Ephemeral] 
    });

    const filter = m => m.author.id === interaction.user.id && m.attachments.size > 0;
    const collector = interaction.channel.createMessageCollector({ filter, time: 60000, max: 1 });

    collector.on('collect', async m => {
        const attachment = m.attachments.first();
        const fileUrl = attachment.url;
        const fileName = attachment.name.toLowerCase();

        try {
            const response = await fetch(fileUrl);
            if (!response.ok) throw new Error('Download failed');
            
            // ★ 修正: バイナリとして取得し、エンコーディングを判定してデコード
            const buffer = await response.arrayBuffer();
            let text = '';

            // BOMチェック (UTF-16 LE: FF FE)
            const u8 = new Uint8Array(buffer);
            if (u8.length >= 2 && u8[0] === 0xFF && u8[1] === 0xFE) {
                const decoder = new TextDecoder('utf-16le');
                text = decoder.decode(buffer);
            } else {
                // デフォルトはUTF-8
                const decoder = new TextDecoder('utf-8');
                text = decoder.decode(buffer);
            }

            let importData = [];

            // 1. JSON形式の解析
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
                    await interaction.followUp({ content: '❌ JSONの解析に失敗しました。', flags: [MessageFlags.Ephemeral] });
                    return;
                }
            } 
            // 2. CSV / Dict形式 (Shovel等)
            else {
                // 改行コード正規化
                const lines = text.split(/\r?\n/);
                for (const line of lines) {
                    if (!line.trim()) continue;
                    // カンマ区切り
                    const parts = line.split(',');
                    if (parts.length >= 2) {
                        const word = parts[0].trim();
                        // 読み（2つ目以降の要素を結合）
                        const read = parts.slice(1).join(',').trim(); 
                        if (word && read) {
                            importData.push({ word, read });
                        }
                    }
                }
            }

            if (importData.length === 0) {
                await interaction.followUp({ content: '⚠️ 有効な辞書データが見つかりませんでした。', flags: [MessageFlags.Ephemeral] });
                return;
            }

            if (mode === 'replace') {
                clearDictionary(guildId);
            }

            const count = importDictionary(guildId, importData);
            await interaction.followUp({ content: `✅ **${count}** 件の単語をインポートしました！ (${modeText})`, flags: [MessageFlags.Ephemeral] });

            if (m.deletable) m.delete().catch(() => {});

        } catch (err) {
            console.error(err);
            await interaction.followUp({ content: `❌ インポート中にエラーが発生しました: ${err.message}`, flags: [MessageFlags.Ephemeral] });
        }
    });

    collector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            interaction.followUp({ content: '⏱️ 時間切れのためインポートをキャンセルしました。', flags: [MessageFlags.Ephemeral] });
        }
    });
}


module.exports = async (interaction, client) => {
    const { customId, guildId } = interaction;

    // --- ActiveSpeech ---
    if (['activespeech_skip', 'activespeech_force', 'activespeech_disable', 'activespeech_enable'].includes(customId)) {
        const manager = client.guildVoiceManagers.get(guildId);
        
        if (customId === 'activespeech_enable') {
            setUserActiveSpeech(guildId, interaction.user.id, true);
            if (manager && manager.isActive()) manager.updateSelfDeaf();
            await interaction.reply({ content: '✅ ActiveSpeechをONにしました。', flags: [MessageFlags.Ephemeral] });
            return true;
        }

        if (!manager) return interaction.reply({ content: '音声接続が見つかりません。', flags: [MessageFlags.Ephemeral] });

        if (customId === 'activespeech_skip') {
            manager.skipCurrent();
            await interaction.reply({ content: '⏭️ スキップしました。', flags: [MessageFlags.Ephemeral] });
        } else if (customId === 'activespeech_force') {
            manager.forcePlayCurrent();
            await interaction.reply({ content: '▶️ 強制再生します。', flags: [MessageFlags.Ephemeral] });
        } else if (customId === 'activespeech_disable') {
            setUserActiveSpeech(guildId, interaction.user.id, false);
            manager.forcePlayCurrent();
            await interaction.reply({ content: '🚫 ActiveSpeechをOFFにしました。', flags: [MessageFlags.Ephemeral] });
        }
        return true;
    }

    // ==========================================
    // Dictionary Import / Export
    // ==========================================
    
    // --- エクスポート (メニュー表示) ---
    if (customId === 'dict_export_file') {
        const entries = getDictionaryEntries(guildId);
        if (entries.length === 0) {
            await interaction.reply({ content: '⚠️ 辞書にデータが登録されていません。', flags: [MessageFlags.Ephemeral] });
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

    // --- インポート開始 (モード選択画面へ) ---
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

    // --- インポートモード決定 -> ファイル待機 ---
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
        const entries = getDictionaryEntries(guildId);
        if (entries.length === 0) {
            const payload = { content: '⚠️ 削除できる単語がありません。', flags: [MessageFlags.Ephemeral], components: [] };
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
        const payload = { content: content, components: [menuRow, buttonRow], flags: [MessageFlags.Ephemeral] };

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
        const entries = getDictionaryEntries(guildId);
        if (entries.length === 0) return interaction.reply({ content: '📖 辞書にはまだ何も登録されていません。', flags: [MessageFlags.Ephemeral] });
        const listString = entries.map(e => `・**${e.word}** → ${e.read_as}`).join('\n');
        const embed = new EmbedBuilder().setTitle('📖 辞書一覧').setDescription(listString.length > 4000 ? listString.substring(0, 4000) + '...' : listString).setColor(0x00AAFF);
        await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
        return true;
    }

    // --- Speaker (既存) ---
    else if (customId.startsWith('speaker_page_') || customId.startsWith('back_to_charlist_page_')) {
        const parts = customId.split('_');
        const type = parts[parts.length - 1]; 
        const targetUserId = parts[parts.length - 2];
        const page = parseInt(parts[parts.length - 3], 10);

        if (interaction.user.id !== targetUserId) return interaction.reply({ content: '他人の設定メニューは操作できません。', flags: [MessageFlags.Ephemeral] });
        await interaction.update(await createSpeakerUIPayload(client, page, interaction.user.id, type));
        return true;
    }
    else if (customId.startsWith('speaker_type_switch_')) {
        const parts = customId.split('_');
        const targetType = parts[3];
        const targetUserId = parts[4];

        if (interaction.user.id !== targetUserId) return interaction.reply({ content: '他人の設定メニューは操作できません。', flags: [MessageFlags.Ephemeral] });
        await interaction.update(await createSpeakerUIPayload(client, 1, interaction.user.id, targetType));
        return true;
    }
    else if (customId.startsWith('confirm_style_')) {
        const parts = customId.split('_');
        const type = parts[6] || 'voicevox'; 
        const targetUserId = parts[5];
        
        if (interaction.user.id !== targetUserId) return interaction.reply({ content: '他人の設定メニューは操作できません。', flags: [MessageFlags.Ephemeral] });
        const manager = client.guildVoiceManagers.get(guildId);
        if (!manager || !manager.isActive()) return interaction.update({ content: 'BotがVCに参加していません。', embeds: [], components: [] });
        
        const speakerId = parseInt(parts[2], 10);
        const speakerName = parts[3];
        
        setUserSpeakerId(guildId, interaction.user.id, speakerId, type);
        
        await interaction.update({
            content: `✅ あなたの話者を **${speakerName}** (${type === 'ojt' ? 'Open JTalk' : 'VOICEVOX'}) に設定しました。`,
            embeds: [], components: [] 
        });
        return true;
    }

    return false;
};