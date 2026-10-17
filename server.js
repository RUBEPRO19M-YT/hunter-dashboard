const express = require('express');
const session = require('express-session');
const mongoose = require('mongoose');
const fetch = require('node-fetch');
const path = require('path');
const multer = require('multer');
require('dotenv').config();

const app = express();
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.use('/public', express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: process.env.SESSION_SECRET || 'hunter_eventos_secret',
    resave: false,
    saveUninitialized: false
}));

mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/hunter_eventos')
    .then(() => console.log('Conectado a MongoDB'))
    .catch(err => console.error('Error conectando a MongoDB:', err));

// ==========================================
// MODELOS
// ==========================================

// El username NO es único a nivel de Mongo de forma dura, porque dos
// usuarios distintos no pueden competir por el mismo nombre de Minecraft
// (eso lo valida registerOrRenameUsername más abajo con un chequeo
// case-insensitive contra Aspirant + BannedName).
const AspirantSchema = new mongoose.Schema({
    discordId: { type: String, unique: true }, // identificador ESTABLE, nunca cambia
    username: { type: String, required: true },
    usernameLower: { type: String, required: true, index: true },
    nameHistory: [{ name: String, changedAt: Date }],
    avatar: String,
    number: { type: Number, unique: true },
    banned: { type: Boolean, default: false },
    banReason: String,
    rank: { type: String, default: 'aspirante' }, // aspirante | verificado | admin, etc.
    skinFilename: String // nombre del archivo .png en public/skins/
});
const Aspirant = mongoose.model('Aspirant', AspirantSchema);

// Nombres que un admin ha bloqueado explícitamente (reservados, ofensivos,
// de un jugador baneado permanentemente, etc.) y que nadie más puede coger.
const BannedNameSchema = new mongoose.Schema({
    nameLower: { type: String, unique: true },
    reason: String,
    addedAt: { type: Date, default: Date.now }
});
const BannedName = mongoose.model('BannedName', BannedNameSchema);

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;
const ADMIN_IDS = process.env.ADMIN_DISCORD_IDS ? process.env.ADMIN_DISCORD_IDS.split(',') : [];

const pendingLauncherAuths = new Map();

function requireAdmin(req, res, next) {
    const user = req.session.user;
    if (!user || !ADMIN_IDS.includes(user.id)) return res.status(403).send('Acceso denegado');
    next();
}

// ==========================================
// VALIDACIÓN DE NOMBRE ÚNICO / PROHIBIDO
// ==========================================
// Usar SIEMPRE esta función tanto al registrar un aspirante nuevo como al
// renombrarlo desde el panel de admin. Nunca actualices "username" a pelo
// en otro sitio, o te saltas estas comprobaciones.
async function registerOrRenameUsername(discordId, requestedName, { isNewAspirant = false } = {}) {
    const nameLower = requestedName.trim().toLowerCase();

    if (!nameLower || nameLower.length > 16) {
        return { ok: false, message: 'Nombre inválido (máximo 16 caracteres).' };
    }

    const banned = await BannedName.findOne({ nameLower });
    if (banned) {
        return { ok: false, message: `Ese nombre está bloqueado: ${banned.reason || 'sin motivo especificado'}.` };
    }

    const taken = await Aspirant.findOne({ usernameLower: nameLower, discordId: { $ne: discordId } });
    if (taken) {
        return { ok: false, message: 'Ese nombre ya lo está usando otro aspirante.' };
    }

    if (isNewAspirant) {
        return { ok: true };
    }

    // Es un rename sobre un aspirante existente: el discordId (y por tanto
    // el UUID que le pasamos a Minecraft) no cambia nunca, así que el
    // inventario en el servidor se mantiene intacto.
    const aspirant = await Aspirant.findOne({ discordId });
    if (!aspirant) return { ok: false, message: 'Aspirante no encontrado.' };

    aspirant.nameHistory = aspirant.nameHistory || [];
    aspirant.nameHistory.push({ name: aspirant.username, changedAt: new Date() });
    aspirant.username = requestedName.trim();
    aspirant.usernameLower = nameLower;
    await aspirant.save();

    return { ok: true, aspirant };
}

// ==========================================
// RUTAS PÚBLICAS / WEB
// ==========================================

app.get('/', async (req, res) => {
    const user = req.session.user;
    let aspirant = null;
    if (user) {
        aspirant = await Aspirant.findOne({ discordId: user.id });
    }
    res.render('index', { user, aspirant, isAdmin: user && ADMIN_IDS.includes(user.id) });
});

app.get('/auth/discord', (req, res) => {
    if (req.query.launcherSession) {
        req.session.launcherSession = req.query.launcherSession;
    }
    res.redirect(`https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify`);
});

app.get('/auth/discord/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.redirect('/');

    try {
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            body: new URLSearchParams({
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                grant_type: 'authorization_code',
                code: code,
                redirect_uri: REDIRECT_URI,
            }),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        const tokenData = await tokenRes.json();

        const userRes = await fetch('https://discord.com/api/users/@me', {
            headers: { authorization: `${tokenData.token_type} ${tokenData.access_token}` },
        });
        const userData = await userRes.json();

        req.session.user = userData;

        let aspirant = await Aspirant.findOne({ discordId: userData.id });
        if (!aspirant) {
            const count = await Aspirant.countDocuments();
            let nextNum = count + 1;
            while (await Aspirant.findOne({ number: nextNum })) {
                nextNum++;
            }

            // Si el username de Discord ya está cogido por otro aspirante o
            // está en la lista negra, le añadimos el número detrás para
            // garantizar unicidad sin bloquear el registro.
            let baseName = userData.username;
            let candidate = baseName;
            let suffix = 0;
            while (true) {
                const check = await registerOrRenameUsername(userData.id, candidate, { isNewAspirant: true });
                if (check.ok) break;
                suffix++;
                candidate = `${baseName}${suffix}`;
            }

            aspirant = new Aspirant({
                discordId: userData.id,
                username: candidate,
                usernameLower: candidate.toLowerCase(),
                avatar: userData.avatar,
                number: nextNum,
                nameHistory: []
            });
            await aspirant.save();
        }

        if (aspirant.banned) {
            return res.render('linked', { aspirant, banned: true });
        }

        if (req.session.launcherSession) {
            const sessionKey = req.session.launcherSession;
            req.session.launcherSession = null;
            pendingLauncherAuths.set(sessionKey, {
                discordId: aspirant.discordId,
                username: aspirant.username,
                avatar: aspirant.avatar,
                number: aspirant.number,
                rank: aspirant.rank
            });
            return res.render('linked', { aspirant, banned: false });
        }

        res.redirect('/');
    } catch (err) {
        console.error(err);
        res.redirect('/');
    }
});

// ==========================================
// API PARA EL LAUNCHER
// ==========================================

app.get('/api/check-launcher-auth', (req, res) => {
    const { sessionKey } = req.query;
    if (sessionKey && pendingLauncherAuths.has(sessionKey)) {
        const userData = pendingLauncherAuths.get(sessionKey);
        pendingLauncherAuths.delete(sessionKey);
        return res.json({ success: true, user: userData });
    }
    res.json({ success: false });
});

app.get('/api/verify/:discordId', async (req, res) => {
    try {
        const aspirant = await Aspirant.findOne({ discordId: req.params.discordId });
        if (!aspirant || aspirant.banned) {
            return res.status(401).json({
                allowed: false,
                message: aspirant?.banned
                    ? `Baneado: ${aspirant.banReason || 'sin motivo especificado'}`
                    : 'No estás registrado.'
            });
        }
        res.json({
            allowed: true,
            number: aspirant.number,
            username: aspirant.username,
            rank: aspirant.rank,
            skinUrl: aspirant.skinFilename ? `/public/skins/${aspirant.skinFilename}` : null
        });
    } catch (err) {
        res.status(500).json({ allowed: false, message: 'Error interno en el servidor.' });
    }
});

app.get('/api/mods', (req, res) => {
    const baseUrl = `${req.protocol}://${req.get('host')}/public/mods`;
    res.json({
        version: "1.6.7",
        mods: [
            { name: "voicechat-forge-1.20.1-2.6.24.jar", url: `${baseUrl}/voicechat-forge-1.20.1-2.6.24.jar` },
            // OJO: esta build de Create es para Minecraft 1.21.1, incompatible con
            // tu modpack (1.20.1-Forge-47.4.10). Sustitúyela por la build 1.20.1
            // real de Create antes de activarla, o el mod fallará al cargar.
            // { name: "create-1.21.1-6.0.10.jar", url: `${baseUrl}/create-1.21.1-6.0.10.jar` },
            { name: "epic-fight-20.14.17-mc1.20.1-forge.jar", url: `${baseUrl}/epic-fight-20.14.17-mc1.20.1-forge.jar` },
            { name: "customtablist-forge-1.20.1.jar", url: `${baseUrl}/customtablist-forge-1.20.1.jar` },
            { name: "architectury-9.2.14-forge.jar", url: `${baseUrl}/architectury-9.2.14-forge.jar` },
            { name: "mcw-furniture-3.4.1-mc1.20.1forge.jar", url: `${baseUrl}/mcw-furniture-3.4.1-mc1.20.1forge.jar` },
            { name: "camera-forge-1.20.1-1.0.20.jar", url: `${baseUrl}/camera-forge-1.20.1-1.0.20.jar` },
            { name: "embeddium-0.3.31+mc1.20.1.jar", url: `${baseUrl}/embeddium-0.3.31+mc1.20.1.jar` },
            { name: "ferritecore-6.0.1-forge.jar", url: `${baseUrl}/ferritecore-6.0.1-forge.jar` },
            { name: "ImmediatelyFast-Forge-1.5.5+1.20.4.jar", url: `${baseUrl}/ImmediatelyFast-Forge-1.5.5+1.20.4.jar` },
            { name: "worldedit-mod-7.2.15.jar", url: `${baseUrl}/worldedit-mod-7.2.15.jar` },
            { name: "modernfix-forge-5.27.88+mc1.20.1.jar", url: `${baseUrl}/modernfix-forge-5.27.88+mc1.20.1.jar` },
            { name: "immersive_cinematics-forge-0.3.3.jar", url: `${baseUrl}/immersive_cinematics-forge-0.3.3.jar` }
        ]
    });
});

// ==========================================
// SKINS (subida básica: PNG 64x64, se sirve de forma estática)
// ==========================================
const skinUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, path.join(__dirname, 'public', 'skins')),
        filename: (req, file, cb) => {
            const discordId = req.session.user?.id;
            cb(null, `${discordId}.png`);
        }
    }),
    limits: { fileSize: 2 * 1024 * 1024 }, // 2MB de margen
    fileFilter: (req, file, cb) => {
        if (file.mimetype !== 'image/png') return cb(new Error('Solo se aceptan archivos PNG.'));
        cb(null, true);
    }
});

app.post('/api/skin/upload', (req, res) => {
    if (!req.session.user) return res.status(401).json({ ok: false, message: 'No autenticado.' });

    skinUpload.single('skin')(req, res, async (err) => {
        if (err) return res.status(400).json({ ok: false, message: err.message });
        if (!req.file) return res.status(400).json({ ok: false, message: 'No se recibió ningún archivo.' });

        await Aspirant.updateOne(
            { discordId: req.session.user.id },
            { skinFilename: `${req.session.user.id}.png` }
        );

        res.json({ ok: true, skinUrl: `/public/skins/${req.session.user.id}.png` });
    });
});

// ==========================================
// ADMIN
// ==========================================

app.get('/admin', requireAdmin, async (req, res) => {
    const aspirants = await Aspirant.find().sort({ number: 1 });
    const bannedNames = await BannedName.find().sort({ addedAt: -1 });
    res.render('admin', { aspirants, bannedNames });
});

app.post('/admin/rename', requireAdmin, async (req, res) => {
    const { discordId, newUsername } = req.body;
    const result = await registerOrRenameUsername(discordId, newUsername);
    if (!result.ok) {
        return res.redirect(`/admin?error=${encodeURIComponent(result.message)}`);
    }
    res.redirect('/admin');
});

app.post('/admin/ban', requireAdmin, async (req, res) => {
    const { discordId, reason } = req.body;
    await Aspirant.updateOne({ discordId }, { banned: true, banReason: reason || 'Sin motivo especificado' });
    res.redirect('/admin');
});

app.post('/admin/unban', requireAdmin, async (req, res) => {
    const { discordId } = req.body;
    await Aspirant.updateOne({ discordId }, { banned: false, banReason: '' });
    res.redirect('/admin');
});

app.post('/admin/rank', requireAdmin, async (req, res) => {
    const { discordId, rank } = req.body;
    await Aspirant.updateOne({ discordId }, { rank });
    res.redirect('/admin');
});

app.post('/admin/banned-names/add', requireAdmin, async (req, res) => {
    const { name, reason } = req.body;
    const nameLower = name.trim().toLowerCase();
    try {
        await BannedName.create({ nameLower, reason });
    } catch (err) {
        // nombre ya en la lista, ignoramos el duplicado
    }
    res.redirect('/admin');
});

app.post('/admin/banned-names/remove', requireAdmin, async (req, res) => {
    const { nameLower } = req.body;
    await BannedName.deleteOne({ nameLower });
    res.redirect('/admin');
});

app.post('/admin/update', requireAdmin, async (req, res) => {
    // Mantenido por compatibilidad con el formulario antiguo de cambio de
    // número / borrado de aspirante.
    const { discordId, newNumber, action } = req.body;
    if (action === 'delete') {
        await Aspirant.deleteOne({ discordId });
    } else if (newNumber) {
        const existing = await Aspirant.findOne({ number: Number(newNumber) });
        if (!existing) {
            await Aspirant.updateOne({ discordId }, { number: Number(newNumber) });
        }
    }
    res.redirect('/admin');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Web Hunter Eventos corriendo en puerto ${PORT}`));
