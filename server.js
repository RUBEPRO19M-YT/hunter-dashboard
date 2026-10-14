const express = require('express');
const session = require('express-session');
const mongoose = require('mongoose');
const fetch = require('node-fetch');
const path = require('path'); // <-- 1. Añadido path
require('dotenv').config();

const app = express();
app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// <-- 2. Hacer pública la carpeta 'public' para que el launcher descargue los mods
app.use('/public', express.static(path.join(__dirname, 'public')));

app.use(session({
    secret: process.env.SESSION_SECRET || 'hunter_eventos_secret',
    resave: false,
    saveUninitialized: false
}));

mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/hunter_eventos')
    .then(() => console.log('Conectado à MongoDB'))
    .catch(err => console.error('Error conectando a MongoDB:', err));

const AspirantSchema = new mongoose.Schema({
    discordId: { type: String, unique: true },
    username: String,
    avatar: String,
    number: { type: Number, unique: true },
    banned: { type: Boolean, default: false }
});
const Aspirant = mongoose.model('Aspirant', AspirantSchema);

const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;
const ADMIN_IDS = process.env.ADMIN_DISCORD_IDS ? process.env.ADMIN_DISCORD_IDS.split(',') : [];

const pendingLauncherAuths = new Map();

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

            aspirant = new Aspirant({
                discordId: userData.id,
                username: userData.username,
                avatar: userData.avatar,
                number: nextNum
            });
            await aspirant.save();
        }

        if (req.session.launcherSession) {
            const sessionKey = req.session.launcherSession;
            req.session.launcherSession = null;
            pendingLauncherAuths.set(sessionKey, {
                discordId: aspirant.discordId,
                username: aspirant.username,
                avatar: aspirant.avatar,
                number: aspirant.number
            });
            return res.render('linked', { aspirant });
        }

        res.redirect('/');
    } catch (err) {
        console.error(err);
        res.redirect('/');
    }
});

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
            return res.status(401).json({ allowed: false, message: 'No estás registrado o estás baneado.' });
        }
        res.json({ allowed: true, number: aspirant.number, username: aspirant.username });
    } catch (err) {
        res.status(500).json({ allowed: false, message: 'Error interno en el servidor.' });
    }
});

// ==========================================
// 3. ENDPOINT PARA QUE EL LAUNCHER RECISE LOS MODS
// ==========================================
app.get('/api/mods', (req, res) => {
    const baseUrl = `${req.protocol}://${req.get('host')}/public/mods`;
    res.json({
        version: "1.6.7",
        mods: [
            { name: "simple-voice-chat-forge-1.20.1.jar", url: `${baseUrl}/simple-voice-chat-forge-1.20.1.jar` },
            { name: "create-1.20.1.jar", url: `${baseUrl}/create-1.20.1.jar` },
            { name: "epicfight-1.20.1.jar", url: `${baseUrl}/epicfight-1.20.1.jar` },
            { name: "tablist-1.20.1.jar", url: `${baseUrl}/tablist-1.20.1.jar` },
            { name: "architectury-9.2.14-forge.jar", url: `${baseUrl}/architectury-9.2.14-forge.jar` },
            { name: "mcw-furniture-3.4.1-mc1.20.1forge.jar", url: `${baseUrl}/mcw-furniture-3.4.1-mc1.20.1forge.jar` },
            { name: "camera-forge-1.20.1-1.0.20.jar", url: `${baseUrl}/camera-forge-1.20.1-1.0.20.jar` },
            { name: "embeddium-0.3.31+mc1.20.1.jar", url: `${baseUrl}/embeddium-0.3.31+mc1.20.1.jar` },
            { name: "ferritecore-6.0.1-forge.jar", url: `${baseUrl}/ferritecore-6.0.1-forge.jar` },
            { name: "ImmediatelyFast-Forge-1.5.5+1.20.4.jar", url: `${baseUrl}/ImmediatelyFast-Forge-1.5.5+1.20.4.jar` },
            { name: "worldedit-mod-7.2.15.jar", url: `${baseUrl}/worldedit-mod-7.2.15.jar` },
            { name: "modernfix-forge-5.27.88+mc1.20.1.jar", url: `${baseUrl}/modernfix-forge-5.27.88+mc1.20.1.jar` }
        ]
    });
});

app.get('/admin', async (req, res) => {
    const user = req.session.user;
    if (!user || !ADMIN_IDS.includes(user.id)) return res.status(403).send('Acceso denegado');
    const aspirants = await Aspirant.find().sort({ number: 1 });
    res.render('admin', { aspirants });
});

app.post('/admin/update', async (req, res) => {
    const user = req.session.user;
    if (!user || !ADMIN_IDS.includes(user.id)) return res.status(403).send('Acceso denegado');

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
