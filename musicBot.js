const { Client, GatewayIntentBits, Events } = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    VoiceConnectionStatus,
    StreamType,
    entersState,
} = require('@discordjs/voice');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ffmpegPath = require('ffmpeg-static');
process.env.FFMPEG_PATH = ffmpegPath;
process.env.PATH = process.env.PATH + path.delimiter + path.dirname(ffmpegPath);

function getYtdlpPath() {
    const isWin = process.platform === 'win32';
    return path.join(__dirname, 'bin', isWin ? 'yt-dlp.exe' : 'yt-dlp');
}

async function ensureYtdlp() {
    const p = getYtdlpPath();
    if (fs.existsSync(p)) return true;
    try {
        console.log('تحميل yt-dlp للمنصة الحالية...');
        fs.mkdirSync(path.dirname(p), { recursive: true });
        const isWin = process.platform === 'win32';
        const url = isWin
            ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
            : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        fs.writeFileSync(p, buf);
        if (!isWin) fs.chmodSync(p, 0o755);
        console.log('تم تحميل yt-dlp بنجاح.');
        return true;
    } catch (e) {
        console.error('فشل تحميل yt-dlp:', e.message);
        return false;
    }
}

const YTDLP = getYtdlpPath();

function runYtDlp(args) {
    return spawn(YTDLP, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
}

function streamSong(query, startSeconds) {
    const isLink = /^https?:\/\//i.test(query);
    const candidates = isLink
        ? [query]
        : [`scsearch1:${query}`];
    const titleFileBase = path.join(os.tmpdir(), `ytdlp_title_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`);
    const baseArgs = [
        '--no-playlist',
        '--no-warnings',
        '-q',
        '-f',
        'ba/b',
        '-o',
        '-',
    ];
    if (startSeconds && startSeconds > 0) {
        baseArgs.push('--downloader', 'ffmpeg', '--downloader-args', `ffmpeg:-ss ${startSeconds}`);
    }

    let activeProc = null;
    let idx = 0;
    let lastErr = null;

    const attempt = (target) => new Promise((resolve, reject) => {
        const titleFile = `${titleFileBase}_${idx++}.txt`;
        const args = baseArgs.concat('--print-to-file', '%(title)s\n%(webpage_url)s', titleFile, target);
        const proc = runYtDlp(args);
        activeProc = proc;

        let done = false;
        const cleanup = () => {
            try { fs.unlinkSync(titleFile); } catch (e) { /* تجاهل */ }
        };
        const readTitle = () => {
            try {
                if (!fs.existsSync(titleFile)) return null;
                const lines = fs.readFileSync(titleFile, 'utf8').split('\n');
                return { title: (lines[0] || '').trim(), url: (lines[1] || '').trim() };
            } catch (e) { return null; }
        };

        const poll = setInterval(() => {
            const info = readTitle();
            if (info && info.title) {
                clearInterval(poll);
                done = true;
                cleanup();
                resolve({ title: info.title, url: info.url || null, stream: proc.stdout });
            }
        }, 100);

        let errTail = '';
        proc.stderr.on('data', (d) => {
            const s = d.toString().trim();
            if (s) errTail = s.split('\n').pop();
        });

        proc.on('error', (e) => {
            clearInterval(poll);
            if (!done) {
                done = true;
                cleanup();
                reject(e);
            }
        });

        proc.on('close', (code) => {
            clearInterval(poll);
            if (!done) {
                done = true;
                const info = readTitle();
                cleanup();
                if (code === 0 && info && info.title) {
                    resolve({ title: info.title, url: info.url || null, stream: proc.stdout });
                } else {
                    reject(new Error(errTail || `رمز الخطأ ${code}`));
                }
            }
        });
    });

    const promise = (async () => {
        for (const target of candidates) {
            try {
                return await attempt(target);
            } catch (e) {
                lastErr = e;
            }
        }
        throw lastErr || new Error('لا يوجد مصدر متاح');
    })();

    return {
        proc: {
            kill() {
                if (activeProc) {
                    try { activeProc.kill(); } catch (e) { /* تجاهل */ }
                }
            },
        },
        promise,
    };
}

function killProc(proc) {
    if (proc && typeof proc.kill === 'function') {
        try { proc.kill(); } catch (e) { /* تجاهل */ }
    }
}

function editAck(q, text) {
    if (!q || !q.textChannel) return;
    if (q.ack) {
        q.ack.edit(text).catch(() => {
            q.textChannel.send(text).catch(() => {});
            q.ack = null;
        });
    } else {
        q.textChannel.send(text).catch(() => {});
    }
}

function createMusicBot(opts) {
    const label = opts.label || 'بوت';
    const aliases = (opts.aliases || [label])
        .map((a) => String(a).replace(/^[#@]/, '').toLowerCase().trim())
        .filter(Boolean);
    const stay247 = !!opts.stay247;
    let forceChannelId = opts.forceChannelId || null;
    const musicEnabled = opts.musicEnabled !== false;
    const onRoomUpdate = typeof opts.onRoomUpdate === 'function' ? opts.onRoomUpdate : null;

    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildVoiceStates,
        ],
    });

    const queues = new Map();
    const boundChannels = new Map();
    const rejoinTimers = new Map();
    let shuttingDown = false;

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    function hookConnection(connection, ch) {
        connection.on('stateChange', (oldS, newS) => {
            if (newS.status === VoiceConnectionStatus.Failed) {
                console.error(`[${label}] فشل الالتصاق بالروم ${ch.id}: ${newS.reason || 'reason غير معروف'}`);
            }
            if (newS.status === VoiceConnectionStatus.Disconnected && stay247) {
                scheduleRejoin(ch.id, ch.guildId, ch.guild.voiceAdapterCreator);
            }
        });
        return connection;
    }

    function scheduleRejoin(channelId, guildId, adapterCreator) {
        if (rejoinTimers.has(guildId)) return;
        rejoinTimers.set(guildId, true);
        console.log(`[${label}] بهربط الروم ${channelId} مرة ثانية`);
        const attempt = async () => {
            if (shuttingDown) { rejoinTimers.delete(guildId); return; }
            try {
                const ch = await client.channels.fetch(channelId);
                const me = client.guilds.cache.get(guildId)?.members?.me;
                if (me && me.voice.channelId === channelId) {
                    console.log(`[${label}] موجود بالروم ${channelId}`);
                    rejoinTimers.delete(guildId);
                    return;
                }
                hookConnection(joinVoiceChannel({
                    channelId,
                    guildId,
                    adapterCreator,
                }), ch);
                console.log(`[${label}] رجعت للروم ${channelId}`);
                rejoinTimers.delete(guildId);
            } catch (e) {
                console.error(`[${label}] إعادة الدخول للروم ${channelId} فشلت: ${e.message} — محاولة أخرى بعد 10 ثوانٍ`);
                setTimeout(attempt, 10000);
            }
        };
        setTimeout(attempt, 2000);
    }

    async function keepJoinedLoop() {
        while (!shuttingDown) {
            try {
                const ch = await client.channels.fetch(forceChannelId);
                const guild = client.guilds.cache.get(ch.guildId);
                const me = guild?.members?.me;
                if (me && me.voice.channelId === forceChannelId) {
                    console.log(`[${label}] موجود بالروم ${forceChannelId}`);
                    return;
                }
                hookConnection(joinVoiceChannel({
                    channelId: ch.id,
                    guildId: ch.guildId,
                    adapterCreator: ch.guild.voiceAdapterCreator,
                }), ch);
                console.log(`[${label}] متصل بالروم ${ch.id}`);
                return;
            } catch (e) {
                console.error(`[${label}] الدخول للروم ${forceChannelId} فشل: ${e.message} — إعادة محاولة كل 10 ثوانٍ`);
                if (shuttingDown) return;
                await sleep(10000);
            }
        }
    }

    client.on(Events.VoiceStateUpdate, (oldS, newS) => {
        if (!stay247 || !forceChannelId) return;
        if (newS.id !== client.user.id) return;
        if (newS.channelId && newS.channelId !== forceChannelId) {
            console.log(`[${label}] تم تحريكي لروم آخر (${newS.channelId})، برجع للروم المحدد ${forceChannelId}`);
            scheduleRejoin(forceChannelId, newS.guild.id, newS.guild.voiceAdapterCreator);
        }
    });

    client.once(Events.ClientReady, async (c) => {
        console.log(`[${label}] البوت شغال! الاسم: ${c.user.tag}`);
        if (forceChannelId) {
            setTimeout(() => keepJoinedLoop(), 500);
        }
    });

    function destroy() {
        shuttingDown = true;
        rejoinTimers.clear();
        for (const [guildId, q] of queues) {
            try { q.proc && killProc(q.proc); } catch (e) { /* تجاهل */ }
            try { q.player.stop(true); } catch (e) { /* تجاهل */ }
            try {
                if (q.connection && q.connection.state.status !== VoiceConnectionStatus.Destroyed) {
                    q.connection.destroy();
                }
            } catch (e) { /* تجاهل */ }
        }
        queues.clear();
        try { client.destroy(); } catch (e) { /* تجاهل */ }
    }

    async function playNext(guildId) {
        const q = queues.get(guildId);
        if (!q || q.playing) return;
        if (q.songs.length === 0) return;

        const song = q.songs[0];
        const startAt = q.startAt || 0;
        q.startAt = 0;
        q.playing = true;
        q.playId = (q.playId || 0) + 1;
        const myId = q.playId;

        const sp = streamSong(song.urlReal || song.url, startAt);
        q.proc = sp.proc;

        let result;
        try {
            result = await sp.promise;
        } catch (e) {
            const current = queues.get(guildId);
            if (!current || current.playId !== myId) return;
            q.proc = null;
            q.playing = false;
            q.seeking = false;
            editAck(q, `❌ خطأ أثناء تشغيل **${song.title || song.url}**: ${e.message}`);
            q.songs.shift();
            return playNext(guildId);
        }

        const current = queues.get(guildId);
        if (!current || current.playId !== myId) {
            killProc(sp.proc);
            return;
        }

        song.title = result.title || song.title || song.url;
        if (result.url) song.urlReal = result.url;

        const resource = createAudioResource(result.stream, {
            inputType: StreamType.Arbitrary,
            inlineVolume: true,
        });
        const volLevel = q.volLevel || 100;
        resource.volume.setVolume(volLevel / 100);
        q.volume = resource.volume;
        q.seeking = false;

        q.player.play(resource);
        const mention = song.requester ? `<@${song.requester}> ` : '';
        q.textChannel.send(`${mention}✅ تم تشغيل: **${song.title}**`).catch(() => {});
    }

    async function handlePlay(message, query) {
        const voiceChannel = message.member.voice.channel;
        if (!voiceChannel) return message.channel.send('❌ لازم تكون في روم صوتي.');

        const botVoice = message.guild.members.me.voice.channel;
        if (botVoice && botVoice.id !== voiceChannel.id) {
            return message.channel.send('❌ انا في روم ثاني.');
        }

        const song = { title: null, url: query, requester: message.author.id };

        let q = queues.get(message.guild.id);
        if (q) {
            q.songs.push(song);
            if (!q.playing) playNext(message.guild.id);
            return message.channel.send(`${message.author} **${query}**`);
        }

        const ack = null;
        song.isFirst = false;

        q = {
            textChannel: message.channel,
            voiceChannel,
            connection: null,
            player: createAudioPlayer(),
            songs: [song],
            proc: null,
            playing: false,
            repeat: false,
            volume: null,
            volLevel: 100,
            seeking: false,
            startAt: 0,
            ack,
        };
        queues.set(message.guild.id, q);

        let connection;
        try {
            connection = joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: message.guild.id,
                adapterCreator: message.guild.voiceAdapterCreator,
            });
            q.connection = connection;

            connection.on('stateChange', (oldS, newS) => {
                if (newS.status === VoiceConnectionStatus.Disconnected) {
                    const reason = newS.reason || 'unknown';
                    if (reason === 'manual') {
                        stopQueue(message.guild.id);
                        message.channel.send('⚡ انقطعت أنا من الروم الصوتي.').catch(() => {});
                    }
                }
            });

            connection.subscribe(q.player);

            await entersState(connection, VoiceConnectionStatus.Ready, 20000);
        } catch (e) {
            queues.delete(message.guild.id);
            killProc(q.proc);
            q.proc = null;
            if (connection) {
                try { connection.destroy(); } catch (e2) { /* تجاهل */ }
            }
            return (q.ack ? q.ack.edit('❌ ما قدرت أدخل الروم الصوتي. تأكد من صلاحيات البوت واتصال الشبكة.') : Promise.resolve()).catch(() => {});
        }

        q.player.on(AudioPlayerStatus.Idle, () => {
            const current = queues.get(message.guild.id);
            if (!current) return;
            if (current.seeking) return;
            killProc(current.proc);
            current.proc = null;
            if (!current.repeat) {
                current.songs.shift();
            }
            current.playing = false;
            playNext(message.guild.id);
        });

        q.player.on('error', (error) => {
            console.error(`[${label}] خطأ في المشغل:`, error.message);
            const current = queues.get(message.guild.id);
            if (!current) return;
            killProc(current.proc);
            current.proc = null;
            current.songs.shift();
            current.playing = false;
            playNext(message.guild.id);
        });

        await playNext(message.guild.id);
    }

    function stopQueue(guildId) {
        const q = queues.get(guildId);
        if (!q) return;
        queues.delete(guildId);
        killProc(q.proc);
        q.proc = null;
        try { q.player.stop(true); } catch (e) { /* تجاهل */ }
        if (stay247) {
            return;
        }
        if (q.connection && q.connection.state.status !== VoiceConnectionStatus.Destroyed) {
            try { q.connection.destroy(); } catch (e) { /* تجاهل */ }
        }
    }

    if (musicEnabled) {
        client.on(Events.MessageCreate, async (message) => {
            if (message.author.bot || !message.guild) return;

            const content = message.content.trim();
            const lower = content.toLowerCase();

            const strippedLower = lower.replace(/^[#@]+/, '').trim();
            if (content.length <= 40 && !/^(ش|شغل|p)\s/i.test(lower)) {
                console.log(`[${label}] (${client.user.tag}) استقبل رسالة: "${content}" → مجردة: "${strippedLower}"`);
            }
            if (aliases.length && aliases.includes(strippedLower)) {
                console.log(`[${label}] (${client.user.tag}) طابق الاختصار: "${content}"`);
                message.channel.send(`✅ هاك البوت: **${client.user.tag}** — دخلت رومك <#${message.member.voice.channel?.id || ''}>`).catch(() => {});
                console.log(`[${label}] استلمت الاختصار من ${message.author.tag} في القناة ${message.channel.id}`);
                const userVoice = message.member.voice.channel;
                if (!userVoice) {
                    console.log(`[${label}] المستخدم مو داخل روم صوتي، أتجاهل`);
                    return;
                }
                try {
                    const me = message.guild.members.me;
                    if (me && me.voice.channelId === userVoice.id) {
                        message.react('✅').catch((e) => console.error(`[${label}] فشل الرياكشن (بالروم): ${e.message}`));
                        return;
                    }
                    const targetCh = await client.channels.fetch(userVoice.id);
                    if (forceChannelId !== targetCh.id) {
                        forceChannelId = targetCh.id;
                        if (onRoomUpdate) onRoomUpdate(targetCh.id);
                        console.log(`[${label}] تمت إعادة توجيه الروم المحدد إلى ${targetCh.id}`);
                    }
                    rejoinTimers.delete(message.guild.id);
                    const connection = hookConnection(joinVoiceChannel({
                        channelId: targetCh.id,
                        guildId: targetCh.guildId,
                        adapterCreator: targetCh.guild.voiceAdapterCreator,
                    }), targetCh);
                    let reacted = false;
                    const doReact = () => {
                        if (reacted) return;
                        reacted = true;
                        message.react('✅').catch((e) => console.error(`[${label}] فشل الرياكشن (بعد الدخول): ${e.message}`));
                    };
                    connection.once(VoiceConnectionStatus.Ready, doReact);
                    connection.once(VoiceConnectionStatus.Signalling, doReact);
                    setTimeout(doReact, 4000);
                    console.log(`[${label}] بدأت الدخول للروم ${targetCh.id}`);
                } catch (e) {
                    console.error(`[${label}] فشل الدخول بالاختصار: ${e.message}`);
                }
                return;
            }

            const isCommand =
                /^(ش|شغل|p)\s+/i.test(lower) ||
                /^(واقف|stop|ايقاف|س|سكب|s|skip)$/i.test(lower) ||
                /^(صوت|ص|v)\s*\d+$/i.test(lower) ||
                /^قدم\s+\d+$/i.test(lower) ||
                /^(تكرار|ثبت)$/i.test(lower);
            if (!isCommand) return;

            const botVoice = message.guild.members.me.voice.channel;
            if (botVoice) {
                const userVoice = message.member.voice.channel;
                if (!userVoice || userVoice.id !== botVoice.id) {
                    return;
                }
            }

            const boundChannelId = boundChannels.get(message.guild.id);
            if (boundChannelId && message.channel.id !== boundChannelId) return;

            if (lower === 'ثبت') {
                boundChannels.set(message.guild.id, message.channel.id);
                return message.channel.send('✅ تم تثبيت البوت في هذا الروم.');
            }

            if (/^(واقف|stop|ايقاف)$/i.test(lower)) {
                const q = queues.get(message.guild.id);
                if (!q) return message.channel.send('❌ ما فيه أغنية تشتغل حالياً.');
                stopQueue(message.guild.id);
                return message.channel.send(stay247 ? '⏹️ تم إيقاف الأغنية. (باقي في الروم)' : '⏹️ تم إيقاف الأغنية وخروج البوت.');
            }

            if (/^(س|سكب|s|skip)$/i.test(lower)) {
                const q = queues.get(message.guild.id);
                if (!q || !q.playing) return message.channel.send('❌ ما فيه أغنية تشتغل حالياً.');
                const skippedTitle = (q.songs[0] && (q.songs[0].title || q.songs[0].url)) || 'الأغنية';
                killProc(q.proc);
                q.proc = null;
                q.player.stop(true);
                return message.channel.send(`⏭️ تم تخطي الأغنية: **${skippedTitle}**`);
            }

            const volumeMatch = content.match(/^(?:صوت|ص|v)\s*(\d+)$/i);
            if (volumeMatch) {
                const q = queues.get(message.guild.id);
                if (!q || !q.playing || !q.songs[0]) return message.channel.send('❌ ما فيه أغنية تشتغل حالياً.');
                let vol = parseInt(volumeMatch[1], 10);
                vol = Math.max(0, Math.min(150, vol));
                q.volLevel = vol;
                if (q.volume) q.volume.setVolume(vol / 100);
                return message.channel.send(`🎚️ الصوت الآن: **${vol}%**`);
            }

            const seekMatch = content.match(/^قدم\s+(\d+)\s*$/i);
            if (seekMatch) {
                const q = queues.get(message.guild.id);
                if (!q || !q.playing || !q.songs[0]) return message.channel.send('❌ ما فيه أغنية تشتغل حالياً.');
                const secs = parseInt(seekMatch[1], 10);
                if (!isFinite(secs) || secs < 1) return message.channel.send('❌ اكتب رقم ثواني أكبر من صفر. مثال: قدم 30');
                const elapsed =
                    q.player.state.status === AudioPlayerStatus.Playing
                        ? q.player.state.resource.playbackDuration / 1000
                        : 0;
                const target = Math.floor(elapsed) + secs;
                killProc(q.proc);
                q.proc = null;
                q.seeking = true;
                q.startAt = target;
                q.playId = (q.playId || 0) + 1;
                q.playing = false;
                playNext(message.guild.id);
                return message.channel.send(`⏩ تم التقدم **${secs} ثانية** من الأغنية.`);
            }

            if (lower === 'تكرار') {
                const q = queues.get(message.guild.id);
                if (!q || !q.playing || q.songs.length === 0) return message.channel.send('❌ ما فيه أغنية تشتغل حالياً.');
                q.repeat = !q.repeat;
                const label2 = q.songs[0].title || q.songs[0].url;
                return message.channel.send(`🔁 التكرار ${q.repeat ? 'مفعل' : 'موقف'} — **${label2}**`);
            }

            const playMatch = content.match(/^(?:ش|شغل|p)\s+(.+)$/i);
            if (!playMatch) return;
            const query = playMatch[1].trim();
            if (!query) return message.channel.send('❌ اكتب اسم الأغنية أو الرابط.');

            await handlePlay(message, query);
        });
    }

    return { client, label, stay247, forceChannelId, queues, boundChannels, destroy };
}

module.exports = { createMusicBot, ensureYtdlp };