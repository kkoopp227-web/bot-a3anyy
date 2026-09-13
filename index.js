const { createMusicBot, ensureYtdlp } = require('./musicBot');
const http = require('http');

const httpServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('البوت شغال ✅');
});
const WEB_PORT = process.env.PORT || 3000;
httpServer.listen(WEB_PORT, () => console.log(`خادم الصحة مستمع على المنفذ ${WEB_PORT}`));

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
            out.push({ label: '#' + n, token: g.token, channelId: g.id || g.room });
        } else {
            const missing = g.token ? `bot_${n}_id` : (g.id || g.room) ? `bot_${n}_token` : `bot_${n}_token و bot_${n}_id`;
            console.warn(`⚠️ بوت #${n}: ناقص ${missing} من متغيرات Render — تم تجاهله.`);
        }
    }
    if (out.length === 0 && process.env.TOKEN && process.env.ROOM_ID) {
        out.push({ label: '#1', token: String(process.env.TOKEN).trim(), channelId: String(process.env.ROOM_ID).trim() });
    }
    return out;
}

const handles = [];

const allowedGuildIds = (process.env.ALLOWED_GUILD_ID || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

async function main() {
    const bots = envBotsList();
    if (bots.length === 0) {
        console.error('❌ ما في بوتات! ضبط في متغيرات Render:\n   bot_1_token = توكن البوت\n   bot_1_id = ايدي الروم الصوتي\n(أو السهل: TOKEN + ROOM_ID لبوت واحد)');
        process.exit(1);
    }
    console.log('تشغيل ' + bots.length + ' بوت: ' + bots.map((b) => b.label).join('، '));
    const ok = await ensureYtdlp();
    if (!ok) console.error('تحذير: فشل تحضير yt-dlp — الأغاني لن تعمل على هذا الجهاز.');
    for (const item of bots) {
        try {
            const handle = createMusicBot({
                label: item.label,
                aliases: buildAliases(item.label),
                token: item.token,
                stay247: true,
                forceChannelId: item.channelId,
                allowedGuildIds,
            });
            await handle.client.login(item.token);
            handles.push(handle);
            console.log(`[${item.label}] تسجيل الدخول ناجح.`);
        } catch (e) {
            console.error(`[${item.label}] فشل التسجيل: ${e.message}`);
        }
    }
}

process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e));
process.on('SIGINT', () => {
    for (const h of handles) {
        try { h.destroy(); } catch (e) { /* تجاهل */ }
    }
    process.exit(0);
});

main();