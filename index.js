const { Events } = require('discord.js');
const { createMusicBot, ensureYtdlp } = require('./musicBot');
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
    return loadBots();
}

function envBotsList() {
    const groups = {};
    for (const key of Object.keys(process.env)) {
        const m = /^bot_(\d+)_(token|id|room)$/i.exec(key);
        if (!m) continue;
        const n = parseInt(m[1], 10);
        const kind = m[2].toLowerCase();
        if (!groups[n]) groups[n] = {};
        groups[n][kind] = String(process.env[key] || '').trim();
    }
    const out = [];
    const nums = Object.keys(groups).sort((a, b) => Number(a) - Number(b));
    for (const n of nums) {
        const g = groups[n];
        if (g.token && (g.id || g.room)) {
            out.push({ label: '#' + n, token: g.token, channelId: g.id || g.room, stay247: true, fromEnv: true });
        } else {
            const missing = g.token ? `bot_${n}_id` : (g.id || g.room) ? `bot_${n}_token` : `bot_${n}_token و bot_${n}_id`;
            console.warn(`⚠️ بوت #${n}: ناقص ${missing} من متغيرات Render — تم تجاهله.`);
        }
    }
    return out;
}

async function startAllFromDisk() {
    const envBots = envBotsList();
    const local = await resolveBotsState();
    const envTokens = new Set(envBots.map((b) => b.token));
    const merged = envBots.concat(local.filter((b) => !envTokens.has(b.token)));
    console.log('تشغيل ' + merged.length + ' بوت: ' + (merged.map((b) => b.label).join('، ') || 'لا شيء') + (envBots.length ? ` (من متغيرات Render: ${envBots.length})` : ''));
    let i = 1;
    for (const item of merged) {
        try {
            await startSub(item, i);
            i++;
        } catch (e) {
            console.error(`[${item.label}] فشل التشغيل من البداية: ${e.message}`);
        }
    }
}

const main = createMusicBot({ label: 'الرئيسي', token: process.env.MAIN_TOKEN || process.env.token || '', stay247: false, musicEnabled: false });
let mainToken = process.env.MAIN_TOKEN || process.env.token || fileOr('MAIN_TOKEN') || fileOr('token') || config.token || '';

main.client.once(Events.ClientReady, async (c) => {
    console.log(`البوت الرئيسي شغال: ${c.user.tag}`);
    await startAllFromDisk();
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