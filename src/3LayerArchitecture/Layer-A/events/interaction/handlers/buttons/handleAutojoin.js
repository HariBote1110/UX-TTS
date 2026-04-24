const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ChannelSelectMenuBuilder, ChannelType, MessageFlags, ComponentType } = require('discord.js');
const { createAutojoinMenuPayload, createStatusMessage } = require('../../../../utils/helpers');
const {
    getUserSettings, getGuildSettings, getIgnoreChannels, getAllowChannels, getAllChannelPairs,
    setUserAutoJoin, setGuildAutoJoin, addChannelPair, removeChannelPair
} = require('../../../../database');

const ITEMS_PER_PAGE = 25;

function buildPagedSelectPayload(items, page, customIdSubmit, customIdPage, placeholder, statusMsgFn, label, itemLabel) {
    const totalPages = Math.ceil(items.length / ITEMS_PER_PAGE);
    page = Math.max(1, Math.min(page, totalPages));
    const startIndex = (page - 1) * ITEMS_PER_PAGE;
    const options = items.slice(startIndex, startIndex + ITEMS_PER_PAGE);

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(customIdSubmit)
        .setPlaceholder(placeholder)
        .setMinValues(1)
        .setMaxValues(options.length)
        .addOptions(options);

    const menuRow = new ActionRowBuilder().addComponents(selectMenu);
    const prevButton = new ButtonBuilder().setCustomId(`${customIdPage}_${page - 1}`).setLabel('◀ 前へ').setStyle(ButtonStyle.Secondary).setDisabled(page === 1);
    const nextButton = new ButtonBuilder().setCustomId(`${customIdPage}_${page + 1}`).setLabel('次へ ▶').setStyle(ButtonStyle.Secondary).setDisabled(page === totalPages);
    const buttonRow = new ActionRowBuilder().addComponents(prevButton, nextButton);

    const content = `${label}を選択してください。（全${items.length}件中 ${startIndex + 1}〜${Math.min(startIndex + ITEMS_PER_PAGE, items.length)}件を表示）`;
    return statusMsgFn('info', content, { components: [menuRow, buttonRow], flags: [MessageFlags.Ephemeral] });
}

function hasConfigBack(interaction) {
    return interaction.message?.components?.some(row =>
        row.components?.some(c => c.customId === 'config_back_main')
    ) ?? false;
}

module.exports = async (interaction, client) => {
    const { customId, guildId } = interaction;

    // --- 1. メインメニュー操作 ---
    if (customId === 'autojoin_menu_user_toggle') {
        const settings = await getUserSettings(guildId, interaction.user.id);
        await setUserAutoJoin(guildId, interaction.user.id, !settings.auto_join);
        await interaction.update(await createAutojoinMenuPayload(guildId, interaction.user.id, interaction.member.permissions, { showBack: hasConfigBack(interaction) }));
        return true;
    }
    else if (customId === 'autojoin_menu_server_toggle') {
        const settings = await getGuildSettings(guildId);
        await setGuildAutoJoin(guildId, !settings.auto_join_enabled);
        await interaction.update(await createAutojoinMenuPayload(guildId, interaction.user.id, interaction.member.permissions, { showBack: hasConfigBack(interaction) }));
        return true;
    }
    else if (customId === 'autojoin_back_to_main') {
        await interaction.update(await createAutojoinMenuPayload(guildId, interaction.user.id, interaction.member.permissions, { showBack: hasConfigBack(interaction) }));
        return true;
    }

    // --- 2. 除外設定 (Ignore) ---
    else if (customId === 'autojoin_menu_ignore') {
        const currentIgnores = await getIgnoreChannels(guildId);
        const names = currentIgnores.length > 0
            ? currentIgnores.map(id => `・${interaction.guild.channels.cache.get(id)?.name || `不明 (${id})`}`).join('\n')
            : '（設定なし）';

        const fromConfig = hasConfigBack(interaction);
        const embed = new EmbedBuilder().setTitle('🚫 除外チャンネル設定').setDescription(names).setColor(0xFF0000);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('autojoin_ignore_add_open').setLabel('追加').setStyle(ButtonStyle.Success).setEmoji('➕'),
            new ButtonBuilder().setCustomId('autojoin_ignore_remove_open').setLabel('削除').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
            new ButtonBuilder().setCustomId('autojoin_back_to_main').setLabel('戻る').setStyle(ButtonStyle.Secondary).setEmoji('↩️'),
            ...(fromConfig ? [new ButtonBuilder().setCustomId('config_back_main').setLabel('◀ 戻る').setStyle(ButtonStyle.Secondary)] : [])
        );
        await interaction.update({ embeds: [embed], components: [row] });
        return true;
    }
    else if (customId === 'autojoin_ignore_add_open') {
        const select = new ChannelSelectMenuBuilder()
            .setCustomId('autojoin_ignore_add_submit')
            .setPlaceholder('除外するボイスチャンネルを選択')
            .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
            .setMinValues(1)
            .setMaxValues(25);
        const row = new ActionRowBuilder().addComponents(select);
        await interaction.reply(createStatusMessage('info', '除外するチャンネルを選択してください:', { components: [row], flags: [MessageFlags.Ephemeral] }));
        return true;
    }
    else if (customId === 'autojoin_ignore_remove_open' || customId.startsWith('autojoin_ignore_remove_page_')) {
        const currentIgnores = await getIgnoreChannels(guildId);
        if (currentIgnores.length === 0) return interaction.reply(createStatusMessage('warning', '除外設定されているチャンネルはありません。', { flags: [MessageFlags.Ephemeral] }));
        const page = customId.startsWith('autojoin_ignore_remove_page_') ? (parseInt(customId.split('_').pop(), 10) || 1) : 1;
        const options = currentIgnores.map(id => ({
            label: interaction.guild.channels.cache.get(id)?.name.substring(0, 100) || `不明なチャンネル (${id})`,
            value: id
        }));
        const payload = buildPagedSelectPayload(options, page, 'autojoin_ignore_remove_submit', 'autojoin_ignore_remove_page', '除外解除するチャンネルを選択', createStatusMessage, '除外設定を解除するチャンネル');
        if (customId.startsWith('autojoin_ignore_remove_page_')) await interaction.update(payload);
        else await interaction.reply(payload);
        return true;
    }
    else if (customId === 'autojoin_ignore_list') {
        const currentIgnores = await getIgnoreChannels(guildId);
        if (currentIgnores.length === 0) return interaction.reply(createStatusMessage('warning', '除外設定されているチャンネルはありません。', { flags: [MessageFlags.Ephemeral] }));
        const names = currentIgnores.map(id => `・${interaction.guild.channels.cache.get(id)?.name || `不明 (${id})`}`).join('\n');
        const embed = new EmbedBuilder().setTitle('🚫 除外チャンネル一覧').setDescription(names).setColor(0xFF0000);
        await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
        return true;
    }

    // --- 3. 許可設定 (Allow) ---
    else if (customId === 'autojoin_menu_allow') {
        const currentAllows = await getAllowChannels(guildId);
        const names = currentAllows.length > 0
            ? currentAllows.map(id => `・${interaction.guild.channels.cache.get(id)?.name || `不明 (${id})`}`).join('\n')
            : '（設定なし：除外リスト以外の全チャンネルで動作）';

        const fromConfig = hasConfigBack(interaction);
        const embed = new EmbedBuilder().setTitle('⭕ 許可チャンネル設定').setDescription(names).setColor(0x00FF00);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('autojoin_allow_add_open').setLabel('追加').setStyle(ButtonStyle.Success).setEmoji('➕'),
            new ButtonBuilder().setCustomId('autojoin_allow_remove_open').setLabel('削除').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
            new ButtonBuilder().setCustomId('autojoin_back_to_main').setLabel('戻る').setStyle(ButtonStyle.Secondary).setEmoji('↩️'),
            ...(fromConfig ? [new ButtonBuilder().setCustomId('config_back_main').setLabel('◀ 戻る').setStyle(ButtonStyle.Secondary)] : [])
        );
        await interaction.update({ embeds: [embed], components: [row] });
        return true;
    }
    else if (customId === 'autojoin_allow_add_open') {
        const select = new ChannelSelectMenuBuilder()
            .setCustomId('autojoin_allow_add_submit')
            .setPlaceholder('許可するボイスチャンネルを選択')
            .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
            .setMinValues(1)
            .setMaxValues(25);
        const row = new ActionRowBuilder().addComponents(select);
        await interaction.reply(createStatusMessage('info', '許可するチャンネルを選択してください（複数選択可）:', { components: [row], flags: [MessageFlags.Ephemeral] }));
        return true;
    }
    else if (customId === 'autojoin_allow_remove_open' || customId.startsWith('autojoin_allow_remove_page_')) {
        const currentAllows = await getAllowChannels(guildId);
        if (currentAllows.length === 0) return interaction.reply(createStatusMessage('warning', '許可設定されているチャンネルはありません。', { flags: [MessageFlags.Ephemeral] }));
        const page = customId.startsWith('autojoin_allow_remove_page_') ? (parseInt(customId.split('_').pop(), 10) || 1) : 1;
        const options = currentAllows.map(id => ({
            label: interaction.guild.channels.cache.get(id)?.name.substring(0, 100) || `不明なチャンネル (${id})`,
            value: id
        }));
        const payload = buildPagedSelectPayload(options, page, 'autojoin_allow_remove_submit', 'autojoin_allow_remove_page', '許可解除するチャンネルを選択', createStatusMessage, '許可設定を解除するチャンネル');
        if (customId.startsWith('autojoin_allow_remove_page_')) await interaction.update(payload);
        else await interaction.reply(payload);
        return true;
    }
    else if (customId === 'autojoin_allow_list') {
        const currentAllows = await getAllowChannels(guildId);
        if (currentAllows.length === 0) return interaction.reply(createStatusMessage('info', '許可設定されているチャンネルはありません。（現在は除外リスト以外の全チャンネルで動作します）', { flags: [MessageFlags.Ephemeral] }));
        const names = currentAllows.map(id => `・${interaction.guild.channels.cache.get(id)?.name || `不明 (${id})`}`).join('\n');
        const embed = new EmbedBuilder().setTitle('⭕ 許可チャンネル一覧').setDescription(names).setColor(0x00FF00);
        await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
        return true;
    }

    // --- 4. ペアリング設定 (Pair) ---
    else if (customId === 'autojoin_menu_pair') {
        const pairs = await getAllChannelPairs(guildId);
        let description = '自動接続時にテキストチャンネルを固定します。\n\n**現在の設定:**\n';
        if (pairs.length === 0) description += '（設定なし）';
        else {
            description += pairs.map(p => {
                const vc = interaction.guild.channels.cache.get(p.voice_channel_id);
                const tc = interaction.guild.channels.cache.get(p.text_channel_id);
                return `🔊 ${vc ? vc.name : '削除済VC'} ➡ ${p.voice_channel_id === p.text_channel_id ? '💬 (VC内チャット)' : `📝 ${tc ? tc.name : '削除済TC'}`}`;
            }).join('\n');
        }
        const fromConfig = hasConfigBack(interaction);
        const embed = new EmbedBuilder().setTitle('🔗 チャンネルペアリング設定').setDescription(description).setColor(0x00FF00);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('autojoin_pair_add_start').setLabel('追加/更新').setStyle(ButtonStyle.Success).setEmoji('➕'),
            new ButtonBuilder().setCustomId('autojoin_pair_remove_start').setLabel('削除').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
            new ButtonBuilder().setCustomId('autojoin_back_to_main').setLabel('戻る').setStyle(ButtonStyle.Secondary).setEmoji('↩️'),
            ...(fromConfig ? [new ButtonBuilder().setCustomId('config_back_main').setLabel('◀ 戻る').setStyle(ButtonStyle.Secondary)] : [])
        );
        await interaction.update({ embeds: [embed], components: [row] });
        return true;
    }
    else if (customId === 'autojoin_pair_add_start') {
        const select = new ChannelSelectMenuBuilder()
            .setCustomId('autojoin_pair_select_voice')
            .setPlaceholder('1. ボイスチャンネルを選択')
            .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice).setMinValues(1).setMaxValues(1);
        const row = new ActionRowBuilder().addComponents(select);
        await interaction.reply(createStatusMessage('info', 'まず、対象となる **ボイスチャンネル** を選択:', { components: [row], flags: [MessageFlags.Ephemeral] }));
        return true;
    }

    // ★追加: 「このVCのチャットを使用」ボタンハンドラー
    else if (customId.startsWith('autojoin_pair_use_self_')) {
        const voiceId = customId.split('_')[4];
        // テキストチャンネルIDとして、ボイスチャンネルIDそのものを登録する
        await addChannelPair(guildId, voiceId, voiceId);

        const vc = interaction.guild.channels.cache.get(voiceId);
        await interaction.update({
            content: `✅ 設定を保存しました。\n🔊 **${vc ? vc.name : '不明'}** に自動接続した際、その **VC内チャット** を読み上げ対象にします。`,
            components: []
        });
        return true;
    }

    else if (customId === 'autojoin_pair_remove_start' || customId.startsWith('autojoin_pair_remove_page_')) {
        const pairs = await getAllChannelPairs(guildId);
        if (pairs.length === 0) return interaction.reply(createStatusMessage('warning', '設定がありません。', { flags: [MessageFlags.Ephemeral] }));
        const page = customId.startsWith('autojoin_pair_remove_page_') ? (parseInt(customId.split('_').pop(), 10) || 1) : 1;
        const options = pairs.map(p => {
            const vcName = interaction.guild.channels.cache.get(p.voice_channel_id)?.name || '不明VC';
            const tcName = (p.voice_channel_id === p.text_channel_id) ? '(VC内チャット)' : (interaction.guild.channels.cache.get(p.text_channel_id)?.name || '不明TC');
            return { label: `${vcName} ➡ ${tcName}`.substring(0, 100), value: p.voice_channel_id };
        });
        const payload = buildPagedSelectPayload(options, page, 'autojoin_pair_remove_submit', 'autojoin_pair_remove_page', '削除する設定を選択', createStatusMessage, '削除するペアリング設定');
        if (customId.startsWith('autojoin_pair_remove_page_')) await interaction.update(payload);
        else await interaction.reply(payload);
        return true;
    }

    // --- 5. 自動接続ON/OFF確認 ---
    else if (customId === 'autojoin_enable_confirm_yes') {
        await setGuildAutoJoin(guildId, true);
        const payload = await createAutojoinMenuPayload(guildId, interaction.user.id, interaction.member.permissions, { showBack: hasConfigBack(interaction) });
        payload.embeds = [
            createStatusMessage('success', 'サーバーの自動接続設定を **ON** に変更しました。').embeds[0],
            ...(payload.embeds || [])
        ];
        delete payload.content;
        await interaction.update(payload);
        return true;
    }
    else if (customId === 'autojoin_enable_confirm_no') {
        const payload = await createAutojoinMenuPayload(guildId, interaction.user.id, interaction.member.permissions, { showBack: hasConfigBack(interaction) });
        payload.embeds = [
            createStatusMessage('info', '👌 設定は **OFF** のまま維持されます。').embeds[0],
            ...(payload.embeds || [])
        ];
        delete payload.content;
        await interaction.update(payload);
        return true;
    }

    return false; // 処理しなかった場合
};
