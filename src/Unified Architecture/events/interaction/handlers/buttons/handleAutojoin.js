const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ChannelSelectMenuBuilder, ChannelType, MessageFlags } = require('discord.js');
const { createAutojoinMenuPayload } = require('../../../../utils/helpers');
const { 
    getUserSettings, getGuildSettings, getIgnoreChannels, getAllowChannels, getAllChannelPairs,
    setUserAutoJoin, setGuildAutoJoin
} = require('../../../../database');

module.exports = async (interaction, client) => {
    const { customId, guildId } = interaction;

    // --- 1. メインメニュー操作 ---
    if (customId === 'autojoin_menu_user_toggle') {
        const settings = getUserSettings(guildId, interaction.user.id);
        setUserAutoJoin(guildId, interaction.user.id, !settings.auto_join);
        await interaction.update(await createAutojoinMenuPayload(guildId, interaction.user.id, interaction.member.permissions));
        return true;
    }
    else if (customId === 'autojoin_menu_server_toggle') {
        const settings = getGuildSettings(guildId);
        setGuildAutoJoin(guildId, !settings.auto_join_enabled);
        await interaction.update(await createAutojoinMenuPayload(guildId, interaction.user.id, interaction.member.permissions));
        return true;
    }
    else if (customId === 'autojoin_back_to_main') {
        await interaction.update(await createAutojoinMenuPayload(guildId, interaction.user.id, interaction.member.permissions));
        return true;
    }

    // --- 2. 除外設定 (Ignore) ---
    else if (customId === 'autojoin_menu_ignore') {
        const currentIgnores = getIgnoreChannels(guildId);
        const names = currentIgnores.length > 0
            ? currentIgnores.map(id => `・${interaction.guild.channels.cache.get(id)?.name || `不明 (${id})`}`).join('\n')
            : '（設定なし）';
        
        const embed = new EmbedBuilder().setTitle('🚫 除外チャンネル設定').setDescription(names).setColor(0xFF0000);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('autojoin_ignore_add_open').setLabel('追加').setStyle(ButtonStyle.Success).setEmoji('➕'),
            new ButtonBuilder().setCustomId('autojoin_ignore_remove_open').setLabel('削除').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
            new ButtonBuilder().setCustomId('autojoin_back_to_main').setLabel('戻る').setStyle(ButtonStyle.Secondary).setEmoji('↩️')
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
        await interaction.reply({ content: '除外するチャンネルを選択してください:', components: [row], flags: [MessageFlags.Ephemeral] });
        return true;
    }
    else if (customId === 'autojoin_ignore_remove_open') {
        const currentIgnores = getIgnoreChannels(guildId);
        if (currentIgnores.length === 0) return interaction.reply({ content: '⚠️ 除外設定されているチャンネルはありません。', flags: [MessageFlags.Ephemeral] });
        const options = currentIgnores.map(id => ({ 
            label: interaction.guild.channels.cache.get(id)?.name.substring(0, 100) || `不明なチャンネル (${id})`, 
            value: id 
        })).slice(0, 25);
        const select = new StringSelectMenuBuilder()
            .setCustomId('autojoin_ignore_remove_submit')
            .setPlaceholder('除外解除するチャンネルを選択')
            .setMinValues(1)
            .setMaxValues(options.length)
            .addOptions(options);
        const row = new ActionRowBuilder().addComponents(select);
        await interaction.reply({ content: '除外設定を解除するチャンネルを選択してください:', components: [row], flags: [MessageFlags.Ephemeral] });
        return true;
    }
    else if (customId === 'autojoin_ignore_list') {
        const currentIgnores = getIgnoreChannels(guildId);
        if (currentIgnores.length === 0) return interaction.reply({ content: '除外設定されているチャンネルはありません。', flags: [MessageFlags.Ephemeral] });
        const names = currentIgnores.map(id => `・${interaction.guild.channels.cache.get(id)?.name || `不明 (${id})`}`).join('\n');
        const embed = new EmbedBuilder().setTitle('🚫 除外チャンネル一覧').setDescription(names).setColor(0xFF0000);
        await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
        return true;
    }

    // --- 3. 許可設定 (Allow) ---
    else if (customId === 'autojoin_menu_allow') {
        const currentAllows = getAllowChannels(guildId);
        const names = currentAllows.length > 0
            ? currentAllows.map(id => `・${interaction.guild.channels.cache.get(id)?.name || `不明 (${id})`}`).join('\n')
            : '（設定なし：除外リスト以外の全チャンネルで動作）';
        
        const embed = new EmbedBuilder().setTitle('⭕ 許可チャンネル設定').setDescription(names).setColor(0x00FF00);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('autojoin_allow_add_open').setLabel('追加').setStyle(ButtonStyle.Success).setEmoji('➕'),
            new ButtonBuilder().setCustomId('autojoin_allow_remove_open').setLabel('削除').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
            new ButtonBuilder().setCustomId('autojoin_back_to_main').setLabel('戻る').setStyle(ButtonStyle.Secondary).setEmoji('↩️')
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
        await interaction.reply({ content: '許可するチャンネルを選択してください（複数選択可）:', components: [row], flags: [MessageFlags.Ephemeral] });
        return true;
    }
    else if (customId === 'autojoin_allow_remove_open') {
        const currentAllows = getAllowChannels(guildId);
        if (currentAllows.length === 0) return interaction.reply({ content: '⚠️ 許可設定されているチャンネルはありません。', flags: [MessageFlags.Ephemeral] });
        const options = currentAllows.map(id => ({ 
            label: interaction.guild.channels.cache.get(id)?.name.substring(0, 100) || `不明なチャンネル (${id})`, 
            value: id 
        })).slice(0, 25);
        const select = new StringSelectMenuBuilder()
            .setCustomId('autojoin_allow_remove_submit')
            .setPlaceholder('許可解除するチャンネルを選択')
            .setMinValues(1)
            .setMaxValues(options.length)
            .addOptions(options);
        const row = new ActionRowBuilder().addComponents(select);
        await interaction.reply({ content: '許可設定を解除するチャンネルを選択してください:', components: [row], flags: [MessageFlags.Ephemeral] });
        return true;
    }
    else if (customId === 'autojoin_allow_list') {
        const currentAllows = getAllowChannels(guildId);
        if (currentAllows.length === 0) return interaction.reply({ content: '許可設定されているチャンネルはありません。（現在は除外リスト以外の全チャンネルで動作します）', flags: [MessageFlags.Ephemeral] });
        const names = currentAllows.map(id => `・${interaction.guild.channels.cache.get(id)?.name || `不明 (${id})`}`).join('\n');
        const embed = new EmbedBuilder().setTitle('⭕ 許可チャンネル一覧').setDescription(names).setColor(0x00FF00);
        await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
        return true;
    }

    // --- 4. ペアリング設定 (Pair) ---
    else if (customId === 'autojoin_menu_pair') {
        const pairs = getAllChannelPairs(guildId);
        let description = '自動接続時にテキストチャンネルを固定します。\n\n**現在の設定:**\n';
        if (pairs.length === 0) description += '（設定なし）';
        else {
            description += pairs.map(p => {
                const vc = interaction.guild.channels.cache.get(p.voice_channel_id);
                const tc = interaction.guild.channels.cache.get(p.text_channel_id);
                return `🔊 ${vc ? vc.name : '削除済VC'} ➡ 📝 ${tc ? tc.name : '削除済TC'}`;
            }).join('\n');
        }
        const embed = new EmbedBuilder().setTitle('🔗 チャンネルペアリング設定').setDescription(description).setColor(0x00FF00);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('autojoin_pair_add_start').setLabel('追加/更新').setStyle(ButtonStyle.Success).setEmoji('➕'),
            new ButtonBuilder().setCustomId('autojoin_pair_remove_start').setLabel('削除').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
            new ButtonBuilder().setCustomId('autojoin_back_to_main').setLabel('戻る').setStyle(ButtonStyle.Secondary).setEmoji('↩️')
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
        await interaction.reply({ content: 'まず、対象となる **ボイスチャンネル** を選択:', components: [row], flags: [MessageFlags.Ephemeral] });
        return true;
    }
    else if (customId === 'autojoin_pair_remove_start') {
        const pairs = getAllChannelPairs(guildId);
        if (pairs.length === 0) return interaction.reply({ content: '⚠️ 設定がありません。', flags: [MessageFlags.Ephemeral] });
        const options = pairs.map(p => {
            const vcName = interaction.guild.channels.cache.get(p.voice_channel_id)?.name || '不明VC';
            const tcName = interaction.guild.channels.cache.get(p.text_channel_id)?.name || '不明TC';
            return { label: `${vcName} ➡ ${tcName}`.substring(0, 100), value: p.voice_channel_id };
        }).slice(0, 25);
        const select = new StringSelectMenuBuilder().setCustomId('autojoin_pair_remove_submit').setPlaceholder('削除する設定を選択').addOptions(options);
        const row = new ActionRowBuilder().addComponents(select);
        await interaction.reply({ content: '削除する設定を選択:', components: [row], flags: [MessageFlags.Ephemeral] });
        return true;
    }

    // --- 5. 自動接続ON/OFF確認 ---
    else if (customId === 'autojoin_enable_confirm_yes') {
        setGuildAutoJoin(guildId, true);
        const payload = await createAutojoinMenuPayload(guildId, interaction.user.id, interaction.member.permissions);
        payload.content = '✅ サーバーの自動接続設定を **ON** に変更しました。';
        await interaction.update(payload);
        return true;
    }
    else if (customId === 'autojoin_enable_confirm_no') {
        const payload = await createAutojoinMenuPayload(guildId, interaction.user.id, interaction.member.permissions);
        payload.content = '👌 設定は **OFF** のまま維持されます。';
        await interaction.update(payload);
        return true;
    }

    return false; // 処理しなかった場合
};