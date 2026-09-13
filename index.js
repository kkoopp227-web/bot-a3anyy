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
const { downloadState, uploadState, gistEnabled } = require('./persist');
const http = require('http');
const path = require('path');
const fs = require('fs');

const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('البوت شغال ✅');
});
const WEB_PORT = process.env.PORT || 3000;
httpServer.listen(WEB_PORT, () => console.log(`خادم الصحة مستمع على المنفذ ${WEB_PORT}`));

let config = {};
try {
    config = require('./config.json');
} catch (e) {
    console.log('ما فيه config.json — بستخدم متغيرات البيئة.');
}

const CONFIG_FILE = path.join(__dirname, 'config.json');
const BOTS_FILE = path.join(__dirname, 'bots.json');

function fileOr(name) {
    try {
        return fs.readFileSync(path.join(__dirname, name), 'utf8').trim() || '';
    } catch (e) {
        return '';
    }
}

let subBots = [];
let controlChannelId = process.env.CONTROL_CHANNEL_ID || process.env.controlChannelId || fileOr('CONTROL_CHANNEL_ID') || fileOr('controlChannelId') || config.controlChannelId || '';
let controlRoleId = process.env.CONTROL_ROLE_ID || process.env.controlRoleId || fileOr('CONTROL_ROLE_ID') || fileOr('controlRoleId') || config.controlRoleId || '';
let botRoleId = process.env.BOT_ROLE_ID || process.env.botRoleId || fileOr('BOT_ROLE_ID') || fileOr('botRoleId') || config.botRoleId || '';

function persistConfig() {
    config.controlChannelId = controlChannelId;
    config.controlRoleId = controlRoleId;
    config.botRoleId = botRoleId;
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    } catch (e) {
        console.error('فشل حفظ config.json:', e.message);
    }
    uploadState(config, subBots.map((b) => ({ label: b.label, token: b.token, channelId: b.channelId, stay247: !!b.stay247 })));
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

function buildAliases(name) {
    const stripped = String(name || '').replace(/^[#@]+/, '').toLowerCase().trim();
    const set = new Set();
    if (name) set.add(String(name).toLowerCase());
    if (stripped) {
        set.add(stripped);
        set.add('#' + stripped);
        set.add('@' + stripped);
    }
    return [...set];
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
    config.controlChannelId = controlChannelId;
    config.controlRoleId = controlRoleId;
    config.botRoleId = botRoleId;
    uploadState(config, data)
        .then((ok) => {
            if (!ok) console.error('تنبيه: فشل رفع الحالة للقاعدة — التعديل محفوظ محلياً فقط وسيزول عند إعادة النشر.');
        })
        .catch((e) => console.error('تنبيه: فشل رفع الحالة للقاعدة:', e.message));
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

async function startSub(item, index) {
    let handle = null;
    try {
        handle = createMusicBot({
            label: item.label,
            aliases: buildAliases(item.label),
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
            aliases: buildAliases(item.label),
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

async function resolveBotsState() {
    const local = loadBots();
    let state = null;
    try {
        state = await downloadState();
    } catch (e) {
        console.error('خطأ في تحميل الحالة:', (e && e.message) || e);
    }
    const remote = (state && Array.isArray(state.bots)) ? state.bots : [];
    if (remote.length > local.length) {
        try { fs.writeFileSync(BOTS_FILE, JSON.stringify(remote, null, 2)); } catch (e) { /* تجاهل */ }
        return remote;
    }
    if (local.length > remote.length && state) {
        uploadState(config, local).catch(() => {});
        console.log(`الحالة المحلية أكمل (${local.length} بوت) — أعدت رفعها لتحديث القاعدة.`);
    }
    return local;
}

async function startAllFromDisk() {
    const list = await resolveBotsState();
    console.log('تحميل ' + list.length + ' بوت من الحالة: ' + (list.map((b) => b.label).join('، ') || 'لا شيء'));
    let i = 1;
    for (const item of list) {
        try {
            await startSub(item, i);
            i++;
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
            const index = subBots.indexOf(b) + 1;
            handle = createMusicBot({
                label: b.label,
                aliases: [b.label, `#${index}`, `${index}`, `@${index}`],
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
const statusCmd = new SlashCommandBuilder()
    .setName('حالة')
    .setDescription('عرض حالة كل بوت موسيقي (متصل؟ في أي روم؟)');

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
                value: `الاختصار: \`#${i + 1}\` (أو الاسم)\nالتوكن: \`${maskToken(b.token)}\`\nالروم: <#${b.channelId}>\n24/7: ${b.stay247 ? '✅ مفعل' : '❌ موقف'}`,
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
                new TextInputBuilder().setCustomId('name').setLabel('الاختصار (اكتبه هكذا في الشات)').setStyle(TextInputStyle.Short).setMaxLength(32).setPlaceholder('مثال: #4'),
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

    if (!name) return interaction.editReply('❌ اكتب اختصار في أول خانة (مثل: #4).');
    const normName = name.replace(/^[#@]+/, '').toLowerCase().trim();
    if (!normName) return interaction.editReply('❌ الاختصار لازم يكون رقم أو حروف بعد # مثل: #4.');
    const variants = new Set();
    if (name) variants.add(name.toLowerCase());
    if (normName) { variants.add(normName); variants.add('#' + normName); variants.add('@' + normName); }
    const aliases = [...variants];
    const clash = subBots.some((b) => aliases.some((a) => (b.aliases || []).includes(a)));
    if (clash) {
        return interaction.editReply(`❌ الاختصار \`${name}\` مستخدم من بوت آخر. اختر رقماً مختلفاً (مثل: #${subBots.length + 2}) — كل بوت لازم اختصار مختلف.`);
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
        const entry = { label: name, token, channelId, stay247, aliases, handle: null };
        handle = createMusicBot({
            label: name,
            aliases,
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
        let warn = '';
        try {
            const ch = await handle.client.channels.fetch(channelId);
            if (ch.type !== ChannelType.GuildVoice && ch.type !== ChannelType.GuildStageVoice) {
                warn += `⚠️ <#${channelId}> **مو روم صوتي** — تحقق من الأيدي او استخدم زر الدعوة من اللوحة كبديل.\n`;
            }
            const guild = handle.client.guilds.cache.get(ch.guildId);
            if (!guild) {
                warn += `⚠️ البوت **مو مضاف في هذا السيرفر** أبداً — لازم تدعوه بالرابط قبل ما يدخل الروم.\n`;
            } else {
                const me = ch.guild.members.me;
                const missing = me
                    ? ch.permissionsFor(me).missing([PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak])
                    : [PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak];
                if (missing && missing.length) {
                    warn += `⚠️ البوت **ما عنده صلاحية الدخول أو الكلام** في الروم <#${channelId}> — أعطه رول فيه Connect + Speak.\n`;
                }
            }
        } catch (e2) {
            warn += `⚠️ الروم <#${channelId}> مو داخل سيرفير البوت أو محذوف.\n`;
        }
        const embed = new EmbedBuilder()
            .setTitle('✅ تم إضافة البوت')
            .setColor(0x57f287)
            .setDescription(
                `**${name}** شغال الآن.\n` +
                `الروم: <#${channelId}>\n` +
                `وضع 24/7: ${stay247 ? '✅ مفعل' : '❌ موقف'}\n` +
                `الاختصار: اكتب \`${name}\` في الشات لجلبه لرومك.\n\n` +
                (warn || `✅ كل شيء تمام، خل البوت يدخل الروم خلال ثواني.\n`) +
                `📎 رابط إضافة البوت للسيرفر:\n${invite}\n\n` +
                ((process.env.MONGODB_URI || gistEnabled())
                    ? `✅ التخزين البعيد يعمل — البوت سيبقى بعد إعادة النشر.`
                    : `⚠️ تنبيه: ما في تخزين بعيد (MONGODB_URI/Gist) في Render — هذا البوت سيضيع عند إعادة النشر. حطه في Render عشان يثبت.`)
            );
        return interaction.editReply({ embeds: [embed] });
    } catch (e) {
        if (handle) { try { handle.destroy(); } catch (e2) { /* تجاهل */ } }
        return interaction.editReply(`❌ فشل تشغيل البوت: ${e.message}`);
    }
}

const main = createMusicBot({ label: 'الرئيسي', token: process.env.MAIN_TOKEN || process.env.token || '', stay247: false, musicEnabled: false });
let mainToken = process.env.MAIN_TOKEN || process.env.token || fileOr('MAIN_TOKEN') || fileOr('token') || config.token || '';

main.client.once(Events.ClientReady, async (c) => {
    console.log(`البوت الرئيسي شغال: ${c.user.tag}`);
    const cmds = [menuCommand, restartCommand, setChannelCmd, setRoleCmd, botRoleCmd, statusCmd];
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
            if (interaction.commandName === 'حالة') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                if (subBots.length === 0) return interaction.editReply('لا يوجد بوتات فرعية.');
                const lines = ['**عدد البوتات:** ' + subBots.length];
                for (const b of subBots) {
                    const cl = b.handle?.client;
                    let parts = [];
                    if (!cl || !cl.user) {
                        parts.push('❌ غير متصل');
                    } else {
                        parts.push(cl.user.tag);
                        try {
                            const ch = await cl.channels.fetch(b.channelId).catch(() => null);
                            if (!ch) {
                                parts.push('⚠️ الروم المحدد غير موجود (أو خارج سيرفرات هذا البوت)');
                            } else {
                                const g = cl.guilds.cache.get(ch.guildId);
                                if (!g) {
                                    parts.push('⚠️ البوت مشي في هذا السيرفر');
                                } else {
                                    const me = g.members.me;
                                    const cur = me?.voice?.channelId;
                                    if (cur === b.channelId) parts.push('✅ في رومه المحدد');
                                    else if (cur) parts.push(`⚠️ في روم آخر (${cur})`);
                                    else parts.push('❌ خارج أي روم صوتي');
                                    parts.push(`سيرفر: ${g.name}`);
                                }
                            }
                        } catch (e2) {
                            parts.push('⚠️ فشل فحص الروم');
                        }
                    }
                    lines.push(`**${b.label}** — ${parts.join(' | ')}`);
                }
                return interaction.editReply({ content: lines.join('\n') });
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
    const fileToken = config.token || '';
    console.log('فحص التخزين: MONGODB_URI=' + (process.env.MONGODB_URI ? 'موجود' : 'غائب') + ' | Gist=' + (gistEnabled() ? 'مفعّل' : 'غائب'));
    let state = null;
    try {
        state = await downloadState();
    } catch (e) {
        console.error('downloadState ألقى خطأً:', (e && e.message) || e);
    }
    if (state) {
        if (state.config && typeof state.config === 'object') {
            Object.assign(config, state.config);
            if (fileToken) config.token = fileToken;
        }
        if (Array.isArray(state.bots) && state.bots.length > 0) {
            if (!fs.existsSync(BOTS_FILE)) {
                try { fs.writeFileSync(BOTS_FILE, JSON.stringify(state.bots, null, 2)); } catch (e) { /* تجاهل */ }
            }
        }
        if ((process.env.MONGODB_URI || gistEnabled())) console.log(`تم استرجاع الحالة المحفوظة (${state.bots.length} بوت).`);
    }
    const storageCfgd = !!(process.env.MONGODB_URI || gistEnabled());
    if (storageCfgd) {
        if (state) console.log('✅ التخزين البعيد يعمل — البوتات ستبقى بعد إعادة النشر.');
        else console.error('⚠️ التخزين البعيد معدّ لكن الاتصال فشل! البوتات لن تُستعاد عند إعادة النشر. افحص MONGODB_URI/Gist في Render.');
    } else {
        console.error('⚠️ لا يوجد تخزين بعيد (MONGODB_URI أو Gist) في Render! أي بوت تضيفه سيضيع عند إعادة النشر. حط MONGODB_URI (Secret File) أو GIST_TOKEN/GIST_ID الآن.');
    }
    mainToken = process.env.MAIN_TOKEN || process.env.token || fileOr('MAIN_TOKEN') || fileOr('token') || config.token || '';
    controlChannelId = process.env.CONTROL_CHANNEL_ID || process.env.controlChannelId || fileOr('CONTROL_CHANNEL_ID') || fileOr('controlChannelId') || config.controlChannelId || '';
    controlRoleId = process.env.CONTROL_ROLE_ID || process.env.controlRoleId || fileOr('CONTROL_ROLE_ID') || fileOr('controlRoleId') || config.controlRoleId || '';
    botRoleId = process.env.BOT_ROLE_ID || process.env.botRoleId || fileOr('BOT_ROLE_ID') || fileOr('botRoleId') || config.botRoleId || '';

    if (!mainToken) {
        console.error('ما في توكن! ضبط MAIN_TOKEN (أو ملف Secret File اسمه MAIN_TOKEN، أو config.json).');
        process.exit(1);
    }
    console.log(`استُخدم توكن يبدأ بـ: ${mainToken.slice(0, 6)}...`);
    const ok = await ensureYtdlp();
    if (!ok) console.error('تحذير: فشل تحضير yt-dlp — الأغاني لن تعمل على هذا الجهاز.');
    try {
        await main.client.login(mainToken);
    } catch (e) {
        console.error('فشل تسجيل دخول البوت الرئيسي:', e.message);
        process.exit(1);
    }
})();