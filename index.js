const {
    Events,
    SlashCommandBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    MessageFlags,
    PermissionsBitField,
    ChannelType,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
} = require('discord.js');
const { createMusicBot, ensureYtdlp } = require('./musicBot');
const path = require('path');
const fs = require('fs');
const config = require('./config.json');

const CONFIG_FILE = path.join(__dirname, 'config.json');
const BOTS_FILE = path.join(__dirname, 'bots.json');

let subBots = [];
let controlChannelId = config.controlChannelId || '';
let controlRoleId = config.controlRoleId || '';
let botRoleId = config.botRoleId || '';

function persistConfig() {
    config.controlChannelId = controlChannelId;
    config.controlRoleId = controlRoleId;
    config.botRoleId = botRoleId;
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    } catch (e) {
        console.error('فشل حفظ config.json:', e.message);
    }
}

function loadBots() {
    try {
        if (process.env.BOTS_JSON) {
            const arr = JSON.parse(process.env.BOTS_JSON);
            if (Array.isArray(arr)) return arr;
        }
        return JSON.parse(fs.readFileSync(BOTS_FILE, 'utf8'));
    } catch (e) {
        return [];
    }
}

function persistBots() {
    const data = subBots.map((b) => ({
        label: b.label,
        token: b.token,
        channelId: b.channelId,
        stay247: !!b.stay247,
    }));
    try {
        fs.writeFileSync(BOTS_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('فشل حفظ bots.json:', e.message);
    }
}

function maskToken(token) {
    if (!token) return '؟؟؟';
    if (token.length > 12) return `${token.slice(0, 6)}...${token.slice(-4)}`;
    return '؟؟؟';
}

async function assignBotRole(botUserId) {
    if (!botRoleId) return;
    for (const guild of main.client.guilds.cache.values()) {
        try {
            const member = guild.members.cache.get(botUserId) || await guild.members.fetch(botUserId).catch(() => null);
            if (member && !member.roles.cache.has(botRoleId)) {
                await member.roles.add(botRoleId);
                console.log(`تم إضافة رول البوت للعضو ${botUserId} في السيرفر ${guild.name}`);
            }
        } catch (e) {
            console.error(`فشل إضافة الرول للبوت ${botUserId}: ${e.message}`);
        }
    }
}

async function startSub(item) {
    let handle = null;
    try {
        handle = createMusicBot({
            label: item.label,
            token: item.token,
            stay247: !!item.stay247,
            forceChannelId: item.channelId || null,
            onRoomUpdate: (newId) => {
                item.channelId = newId;
                persistBots();
            },
        });
        await handle.client.login(item.token);
        subBots.push({
            label: item.label,
            token: item.token,
            channelId: item.channelId,
            stay247: !!item.stay247,
            handle,
        });
        await assignBotRole(handle.client.user.id);
        return handle;
    } catch (e) {
        if (handle) {
            try { handle.destroy(); } catch (e2) { /* تجاهل */ }
        }
        throw e;
    }
}

async function startAllFromDisk() {
    for (const item of loadBots()) {
        try {
            await startSub(item);
        } catch (e) {
            console.error(`[${item.label}] فشل التشغيل من البداية: ${e.message}`);
        }
    }
}

async function restartAll() {
    const results = [];
    for (const b of subBots) {
        let handle = null;
        try {
            if (b.handle) {
                try { b.handle.destroy(); } catch (e) { /* تجاهل */ }
                b.handle = null;
            }
            handle = createMusicBot({
                label: b.label,
                token: b.token,
                stay247: b.stay247,
                forceChannelId: b.channelId || null,
                onRoomUpdate: (newId) => {
                    b.channelId = newId;
                    persistBots();
                },
            });
            await handle.client.login(b.token);
            b.handle = handle;
            await assignBotRole(handle.client.user.id);
            results.push({ label: b.label, ok: true, msg: 'يعمل وسيرجع الروم' });
        } catch (e) {
            if (handle) {
                try { handle.destroy(); } catch (e2) { /* تجاهل */ }
            }
            b.handle = null;
            results.push({ label: b.label, ok: false, msg: e.message });
        }
    }
    return results;
}

async function createBotRole(guild) {
    const perms = [
        PermissionsBitField.Flags.ViewChannel,
        PermissionsBitField.Flags.SendMessages,
        PermissionsBitField.Flags.Connect,
        PermissionsBitField.Flags.Speak,
    ];
    let role = botRoleId ? guild.roles.cache.get(botRoleId) : null;
    if (!role) role = guild.roles.cache.find((r) => r.name === 'MusicBot');
    if (role) {
        role = await role.setPermissions(perms).catch(() => role);
    } else {
        role = await guild.roles.create({ name: 'MusicBot', permissions: perms, hoist: false, mentionable: true });
    }
    botRoleId = role.id;
    persistConfig();
    return role;
}

const menuCommand = new SlashCommandBuilder()
    .setName('البوتات')
    .setDescription('فتح لوحة إدارة بوتات الموسيقى');
const restartCommand = new SlashCommandBuilder()
    .setName('اعادة')
    .setDescription('إعادة تشغيل جميع بوتات الموسيقى');
const setChannelCmd = new SlashCommandBuilder()
    .setName('تحديد_شات')
    .setDescription('تحديد الشات اللي تشتغل فيه أوامر السلاش')
    .addChannelOption((o) =>
        o.setName('شات').setDescription('القناة').setRequired(true)
    );
const setRoleCmd = new SlashCommandBuilder()
    .setName('تحديد_رول')
    .setDescription('تحديد الرول المسموح له باستخدام أوامر السلاش')
    .addRoleOption((o) =>
        o.setName('رول').setDescription('الرول').setRequired(true)
    );
const botRoleCmd = new SlashCommandBuilder()
    .setName('رول_البوتات')
    .setDescription('إنشاء أو تحديث رول الموسيقى للبوتات (يدخل روم + يتكلم + يكتب شات)');

function isAllowed(interaction) {
    if (controlChannelId && interaction.channelId !== controlChannelId) return false;
    if (controlRoleId) {
        const member = interaction.member;
        if (!member || !member.roles?.cache?.has(controlRoleId)) return false;
    }
    return true;
}

function menuEmbed() {
    const embed = new EmbedBuilder()
        .setTitle('🎵 لوحة إدارة بوتات الموسيقى')
        .setColor(0x57f287)
        .setDescription('تحكم بالبوتات الفرعية: إضافة بوت أو إعادة تشغيل جميعًا.');
    if (subBots.length === 0) {
        embed.addFields({ name: 'لا يوجد بوتات', value: 'اضغط على "➕ إضافة بوت" لإنشاء بوت جديد.' });
    } else {
        subBots.forEach((b, i) => {
            embed.addFields({
                name: `${i + 1}. ${b.label}`,
                value: `التوكن: \`${maskToken(b.token)}\`\nالروم: <#${b.channelId}>\n24/7: ${b.stay247 ? '✅ مفعل' : '❌ موقف'}`,
            });
        });
    }
    return embed;
}

function menuRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('add_bot').setLabel('➕ إضافة بوت').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('delete_bot').setLabel('🗑️ حذف بوت').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('restart_all').setLabel('🔄 إعادة تشغيل الكل').setStyle(ButtonStyle.Secondary),
    );
}

function deleteSelectRow() {
    return new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
            .setCustomId('delete_bot_select')
            .setPlaceholder('اختر البوت للحذف')
            .addOptions(
                subBots.map((b) =>
                    new StringSelectMenuOptionBuilder()
                        .setLabel(b.label)
                        .setDescription(`الروم: ${b.channelId}`)
                        .setValue(b.label)
                )
            ),
    );
}

function confirmDeleteRow(label) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`confirm_delete_${label}`).setLabel('✅ تأكيد الحذف').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('cancel_delete').setLabel('إلغاء').setStyle(ButtonStyle.Secondary),
    );
}

async function replyMenu(interaction) {
    await interaction.editReply({ embeds: [menuEmbed()], components: [menuRow()] });
}

async function openAddModal(interaction) {
    const modal = new ModalBuilder()
        .setCustomId('create_bot_modal')
        .setTitle('➕ إضافة بوت موسيقي جديد')
        .addComponents(
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('name').setLabel('الاسم / الاختصار').setStyle(TextInputStyle.Short).setMaxLength(32).setPlaceholder('مثال: بوت ٢'),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('token').setLabel('رمز التوكن (Bot Token)').setStyle(TextInputStyle.Short).setPlaceholder('MTAxxxxxxxx...'),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('channelId').setLabel('ايدي الروم الصوتي').setStyle(TextInputStyle.Short).setPlaceholder('مثال: 123456789012345678'),
            ),
            new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('stay').setLabel('وضع 24/7: يبقى بالروم؟ (نعم/لا)').setStyle(TextInputStyle.Short).setValue('نعم'),
            ),
        );
    await interaction.showModal(modal);
}

async function handleCreateModal(interaction) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const name = interaction.fields.getTextInputValue('name').trim();
    const token = interaction.fields.getTextInputValue('token').trim();
    const channelId = interaction.fields.getTextInputValue('channelId').trim();
    const stayRaw = interaction.fields.getTextInputValue('stay').trim().toLowerCase();
    const stay247 = stayRaw === 'نعم' || stayRaw === 'yes' || stayRaw === 'y';

    if (!name) return interaction.editReply('❌ اكتب اسم للبوت.');
    const normName = name.replace(/^[#@]/, '').toLowerCase().trim();
    if (subBots.some((b) => b.label.replace(/^[#@]/, '').toLowerCase().trim() === normName)) {
        return interaction.editReply('❌ في بوت بهذا الاسم من قبل.');
    }
    if (!token || token.length < 30 || !token.includes('.')) {
        return interaction.editReply('❌ التوكن غير صحيح.');
    }
    if (!/^\d{15,22}$/.test(channelId)) {
        return interaction.editReply('❌ ايدي الروم الصوتي غير صحيح.');
    }
    if (stayRaw !== 'نعم' && stayRaw !== 'لا' && stayRaw !== 'yes' && stayRaw !== 'no' && stayRaw !== 'y' && stayRaw !== 'n') {
        return interaction.editReply('❌ اكتب "نعم" أو "لا" في خانة 24/7.');
    }

    let handle = null;
    try {
        const entry = { label: name, token, channelId, stay247, handle: null };
        handle = createMusicBot({
            label: name,
            token,
            stay247,
            forceChannelId: channelId,
            onRoomUpdate: (newId) => {
                entry.channelId = newId;
                channelId = newId;
                persistBots();
            },
        });
        await handle.client.login(token);
        entry.handle = handle;
        subBots.push(entry);
        persistBots();
        await assignBotRole(handle.client.user.id);
        const invite = `https://discord.com/oauth2/authorize?client_id=${handle.client.user.id}&permissions=8&scope=bot`;
        const embed = new EmbedBuilder()
            .setTitle('✅ تم إضافة البوت')
            .setColor(0x57f287)
            .setDescription(
                `**${name}** شغال الآن.\n` +
                `الروم: <#${channelId}>\n` +
                `وضع 24/7: ${stay247 ? '✅ مفعل' : '❌ موقف'}\n\n` +
                `⚠️ إذا ما دخل الروم: تأكد البوت مدعو للسرڤر وم给他 الصلاحيات:\n${invite}`
            );
        return interaction.editReply({ embeds: [embed] });
    } catch (e) {
        if (handle) { try { handle.destroy(); } catch (e2) { /* تجاهل */ } }
        return interaction.editReply(`❌ فشل تشغيل البوت: ${e.message}`);
    }
}

const main = createMusicBot({ label: 'الرئيسي', token: process.env.MAIN_TOKEN || config.token, stay247: false, musicEnabled: false });
const mainToken = process.env.MAIN_TOKEN || config.token;

main.client.once(Events.ClientReady, async (c) => {
    console.log(`البوت الرئيسي شغال: ${c.user.tag}`);
    const cmds = [menuCommand, restartCommand, setChannelCmd, setRoleCmd, botRoleCmd];
    for (const guild of c.guilds.cache.values()) {
        try {
            for (const cmd of cmds) await guild.commands.create(cmd);
        } catch (e) {
            console.error(`فشل تسجيل الأوامر في ${guild.name}:`, e.message);
        }
    }
    main.client.on(Events.GuildCreate, async (g) => {
        try {
            for (const cmd of cmds) await g.commands.create(cmd);
        } catch (e) { console.error('فشل تسجيل الأوامر:', e.message); }
    });
    await startAllFromDisk();
});

main.client.on(Events.InteractionCreate, async (interaction) => {
    try {
        if (interaction.isChatInputCommand()) {
            if (!isAllowed(interaction)) return;

            if (interaction.commandName === 'البوتات') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                return replyMenu(interaction);
            }
            if (interaction.commandName === 'اعادة') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const results = await restartAll();
                const embed = new EmbedBuilder()
                    .setTitle('🔄 إعادة التشغيل')
                    .setColor(results.every((r) => r.ok) ? 0x57f287 : 0xed4245)
                    .setDescription(results.map((r) => `${r.ok ? '✅' : '❌'} **${r.label}**: ${r.msg}`).join('\n') || 'لا يوجد بوتات');
                return interaction.editReply({ embeds: [embed] });
            }
            if (interaction.commandName === 'تحديد_شات') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const ch = interaction.options.getChannel('شات');
                controlChannelId = ch.id;
                persistConfig();
                return interaction.editReply(`✅ تم تحديد الشات: <#${ch.id}> — أوامر السلاش ست تعمل هنا فقط.`);
            }
            if (interaction.commandName === 'تحديد_رول') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const role = interaction.options.getRole('رول');
                controlRoleId = role.id;
                persistConfig();
                return interaction.editReply(`✅ تم تحديد الرول: <@&${role.id}> — هذا الرول فقط يقدر يستخدم أوامر السلاش.`);
            }
            if (interaction.commandName === 'رول_البوتات') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const role = await createBotRole(interaction.guild);
                for (const b of subBots) {
                    if (b.handle) await assignBotRole(b.handle.client.user.id);
                }
                return interaction.editReply(`✅ تم إنشاء/تحديث الرول <@&${role.id}> وتم تطبيقه على جميع البوتات الفرعية.`);
            }
        }

        if (interaction.isButton() && interaction.customId === 'add_bot') {
            if (!isAllowed(interaction)) return;
            return openAddModal(interaction);
        }

        if (interaction.isButton() && interaction.customId === 'delete_bot') {
            if (!isAllowed(interaction)) return;
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            if (subBots.length === 0) {
                return interaction.editReply({ content: 'لا يوجد بوتات لحذفها.', components: [menuRow()] });
            }
            return interaction.editReply({ content: 'اختر البوت اللي تريد حذفه:', components: [deleteSelectRow(), menuRow()] });
        }

        if (interaction.isStringSelectMenu() && interaction.customId === 'delete_bot_select') {
            if (!isAllowed(interaction)) return;
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const label = interaction.values[0];
            const bot = subBots.find((b) => b.label === label);
            if (!bot) {
                return interaction.editReply({ content: '❌ هذا البوت ما عاد موجود.', components: [menuRow()] });
            }
            return interaction.editReply({
                content: `هل متأكد تريد حذف **${label}**؟`,
                components: [confirmDeleteRow(label)],
            });
        }

        if (interaction.isButton() && interaction.customId.startsWith('confirm_delete_')) {
            if (!isAllowed(interaction)) return;
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const label = interaction.customId.slice('confirm_delete_'.length);
            const idx = subBots.findIndex((b) => b.label === label);
            if (idx === -1) {
                return interaction.editReply({ content: '❌ هذا البوت ما عاد موجود.', components: [menuRow()] });
            }
            const b = subBots[idx];
            try { b.handle.destroy(); } catch (e) { /* تجاهل */ }
            subBots.splice(idx, 1);
            persistBots();
            return interaction.editReply({
                content: `✅ تم حذف **${label}**.`,
                components: [menuRow()],
            });
        }

        if (interaction.isButton() && interaction.customId === 'cancel_delete') {
            if (!isAllowed(interaction)) return;
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            return interaction.editReply({ content: 'تم إلغاء الحذف.', components: [menuRow()] });
        }

        if (interaction.isButton() && interaction.customId === 'restart_all') {
            if (!isAllowed(interaction)) return;
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const results = await restartAll();
            const embed = new EmbedBuilder()
                .setTitle('🔄 إعادة تشغيل الكل')
                .setColor(results.every((r) => r.ok) ? 0x57f287 : 0xed4245)
                .setDescription(results.map((r) => `${r.ok ? '✅' : '❌'} **${r.label}**: ${r.msg}`).join('\n') || 'لا يوجد بوتات');
            return interaction.editReply({ embeds: [embed], components: [menuRow()] });
        }

        if (interaction.isModalSubmit() && interaction.customId === 'create_bot_modal') {
            return handleCreateModal(interaction);
        }
    } catch (e) {
        console.error('خطأ في المعالجة:', e);
        try {
            if (interaction.replied || interaction.deferred) {
                await interaction.editReply({ content: 'حدث خطأ.', embeds: [], components: [] });
            } else {
                await interaction.reply({ content: 'حدث خطأ.', flags: MessageFlags.Ephemeral });
            }
        } catch (e2) { /* تجاهل */ }
    }
});

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));
process.on('SIGINT', () => {
    for (const b of subBots) {
        try { b.handle.destroy(); } catch (e) { /* تجاهل */ }
    }
    try { main.destroy(); } catch (e) { /* تجاهل */ }
    process.exit(0);
});

(async () => {
    const ok = await ensureYtdlp();
    if (!ok) console.error('تحذير: فشل تحضير yt-dlp — الأغاني لن تعمل على هذا الجهاز.');
    try {
        await main.client.login(mainToken);
    } catch (e) {
        console.error('فشل تسجيل دخول البوت الرئيسي:', e.message);
        process.exit(1);
    }
})();