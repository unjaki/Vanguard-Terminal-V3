require('dotenv').config(); // MUST BE LINE 1
const CONFIG = {
    API_BASE: ""
};
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const cors = require('cors');
const { google } = require('googleapis');

// 1. Models
const User = require('./models/User'); 
const Division = require('./models/divisions');

const app = express();

// 2. Middleware & Cache Setup
app.use(cors());
app.use(express.json()); // Essential for POST requests
app.use(express.static('public'));

// Google Sheets Auth Helper
const getSheetsClient = () => {
    try {
        const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
        let privateKey = process.env.GOOGLE_PRIVATE_KEY;

        if (!clientEmail || !privateKey) {
            console.warn("⚠️ Google Sheets credentials missing in .env");
            return null;
        }

        // Robust key cleaning
        privateKey = privateKey.trim();
        
        // Remove wrapping quotes if they exist (supports single and double)
        if ((privateKey.startsWith('"') && privateKey.endsWith('"')) ||
            (privateKey.startsWith("'") && privateKey.endsWith("'"))) {
            privateKey = privateKey.substring(1, privateKey.length - 1);
        }
        
        // Convert literal \n strings to actual newlines
        privateKey = privateKey.replace(/\\n/g, '\n');

        if (!privateKey.includes("BEGIN PRIVATE KEY")) {
            console.warn("⚠️ GOOGLE_PRIVATE_KEY is invalid. It doesn't contain the PEM header.");
            return null;
        }

        console.log(`[SHEETS] Attempting Uplink. Email: ${clientEmail.substring(0, 15)}... Key Length: ${privateKey.length}`);

        const auth = new google.auth.GoogleAuth({
            credentials: {
                client_email: clientEmail,
                private_key: privateKey
            },
            scopes: ['https://www.googleapis.com/auth/spreadsheets']
        });

        const sheets = google.sheets({ version: 'v4', auth });
        return sheets;
    } catch (err) {
        console.error("Sheets Init Error:", err.message);
        return null;
    }
};

const groupCache = new Map();
const CACHE_TTL = 300000; // 5 minutes in ms

// 3. Tier Limiter Middleware (Must be defined before routes)
const protectTier = (requiredTier) => {
    return (req, res, next) => {
        // Look for token in 'Authorization' header (standard) or 'x-auth-token'
        const authHeader = req.header('Authorization');
        const token = authHeader ? authHeader.replace('Bearer ', '') : req.header('x-auth-token');

        if (!token) return res.status(401).json({ message: "No token, access denied." });

        try {
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            req.user = decoded;
            req.userTier = decoded.tier; // Attach tier for dynamic token logic later

            if (req.user.tier < requiredTier) {
                return res.status(403).json({ 
                    message: `Access Denied: Requires Tier ${requiredTier}. Your Tier: ${req.user.tier}` 
                });
            }
            next();
        } catch (err) {
            res.status(401).json({ message: "Token is not valid." });
        }
    };
};

// 4. Database Connection
if (!process.env.MONGO_URL) {
    console.error("❌ CRITICAL: MONGO_URL is missing in environment variables!");
} else {
    console.log("📡 Attempting MongoDB Uplink...");
    mongoose.connect(process.env.MONGO_URL)
    .then(async () => {
        console.log("✅ MongoDB Connected Successfully");
        
        // Bootstrap Default User if Empty
        try {
            const count = await User.countDocuments();
            if (count === 0) {
                console.log("🚀 Bootstrapping default CBRN Admin...");
                const hashedPassword = await bcrypt.hash("CBRN123", 10);
                await User.create({
                    username: "CBRN_Admin",
                    password: hashedPassword,
                    tier: 5,
                    unitScope: "CBRN"
                });
                console.log("✅ Created default account: CBRN_Admin / CBRN123");
            }
        } catch (bootErr) {
            console.error("❌ Bootstrap Error:", bootErr.message);
        }
    })
    .catch(err => {
        console.error("❌ MongoDB Connection Error:", err.message);
        console.error("Check if your Mongo Atlas whitelist includes IP 0.0.0.0/0");
    });
}

// 🩺 Debug: Database Status
app.get('/system/status', (req, res) => {
    res.json({
        database: mongoose.connection.readyState === 1 ? "ONLINE" : "OFFLINE",
        uptime: process.uptime(),
        env: process.env.NODE_ENV || "development"
    });
});

// --- ROUTES ---

// Auth Verification for Frontend
app.get('/auth/verify', protectTier(2), (req, res) => {
    res.json({ success: true, tier: req.userTier });
});

// Login (The JWT "Badge" Generator)
app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        console.log(`[AUTH] Login attempt for: ${username}`);

        const userData = await User.findOne({ username });
        if (!userData) {
            console.warn(`[AUTH] User not found: ${username}`);
            return res.status(400).json({ message: "User not found" });
        }

        const isMatch = await bcrypt.compare(password, userData.password);
        if (!isMatch) {
            console.warn(`[AUTH] Invalid credentials for: ${username}`);
            return res.status(400).json({ message: "Invalid credentials" });
        }

        const token = jwt.sign(
            { id: userData._id, tier: userData.tier, scope: userData.unitScope },
            process.env.JWT_SECRET,
            { expiresIn: '8h' }
        );

        // Discord Webhook Notification
        try {
            await axios.post(process.env.DISCORD_WEBHOOK_URL, {
                embeds: [{
                    title: "GSMC System Access",
                    description: `**Officer:** ${username}\n**Access Tier:** ${userData.tier}\n**Scope:** ${userData.unitScope}`,
                    color: userData.tier === 5 ? 15158332 : 3447003,
                    timestamp: new Date()
                }]
            });
        } catch (webhookErr) { console.error("Webhook Failed"); }

        res.json({ 
            message: `Welcome back, ${username}`, 
            token, 
            tier: userData.tier,
            unitScope: userData.unitScope
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/group-info/:groupId', async (req, res) => {
    const { groupId } = req.params;

    if (!groupId || !/^\d+$/.test(groupId)) {
        return res.status(400).json({ 
            error: 'Invalid Group ID', 
            details: 'Numeric ID required.' 
        });
    }

    // 1. Check Cache
    const cached = groupCache.get(groupId);
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
        console.log(`[INTEL] Cache Hit: ${groupId}`);
        return res.json(cached.data);
    }

    try {
        console.log(`[INTEL] Fetching Roblox Data: ${groupId}`);
        // 1. Fetch main group metadata
        const groupRes = await axios.get(`https://groups.roblox.com/v1/groups/${groupId}`, { timeout: 5000 });
        const data = groupRes.data;

        // 2. Fetch roles (ranks)
        const rolesRes = await axios.get(`https://groups.roblox.com/v1/groups/${groupId}/roles`, { timeout: 5000 });
        const roles = rolesRes.data.roles.sort((a, b) => b.rank - a.rank); // Sort by rank level desc

        const result = {
            name: data.name,
            memberCount: data.memberCount,
            description: data.description,
            owner: data.owner ? {
                username: data.owner.username,
                userId: data.owner.userId
            } : { username: "None", userId: 0 },
            shout: data.shout ? data.shout.body : null,
            roles: roles.map(r => ({ name: r.name, rank: r.rank, memberCount: r.memberCount }))
        };

        // Cache result
        groupCache.set(groupId, {
            timestamp: Date.now(),
            data: result
        });

        res.json(result);

    } catch (error) {
        if (error.response?.status === 429) {
            console.warn(`[INTEL] ⚠️ Roblox Rate Limit (429) on Intel.`);
            return res.status(429).json({ 
                error: 'Uplink Congested', 
                message: 'Roblox is limiting requests. Please try again in a few minutes.' 
            });
        }
        console.error('Group API Error:', error.message);
        res.status(500).json({ 
            error: 'Failed to fetch unit data', 
            message: error.message 
        });
    }
});



// Unified Verification Route
app.get('/verify-member/:unitName/:username', protectTier(2), async (req, res) => {
    try {
        const { unitName, username } = req.params;
        console.log(`Scanning for Unit: "${unitName}"`);

        // 1. Roblox RESOLUTION (Exact -> Fuzzy Fallback)
        console.log(`[SCAN] Resolving Roblox Identity: "${username}"`);
        let userData;
        try {
            // PHASE A: Exact Username Lookup (Robust & High Rate Limit)
            const exactRes = await axios.post('https://users.roblox.com/v1/usernames/users', {
                usernames: [username.trim()],
                excludeBannedUsers: false
            }, { timeout: 5000 });
            
            userData = exactRes.data.data[0];

            // PHASE B: Fuzzy Search Fallback (Only if exact fails)
            if (!userData) {
                console.log(`[SCAN] No exact match for "${username}". Attempting fuzzy search...`);
                // limit=1 is more economical for fuzzy search
                const searchRes = await axios.get(`https://users.roblox.com/v1/users/search?keyword=${encodeURIComponent(username.trim())}&limit=1`, { timeout: 5000 });
                userData = searchRes.data.data[0];
            }
        } catch (rbErr) {
            if (rbErr.response?.status === 429) {
                console.warn(`[SCAN] ⚠️ Roblox Rate Limit (429) Enforced.`);
                return res.status(429).json({ message: "Uplink Congested" });
            }
            console.error(`[SCAN] Roblox API Error: ${rbErr.response?.status || rbErr.message}`);
            return res.status(500).json({ message: "Uplink Error" });
        }

        if (!userData) {
            console.warn(`[SCAN] Roblox Keyword NOT FOUND: "${username}"`);
            return res.status(404).json({ message: "User Not Found" });
        }
        
        // 1.5 Find Target Unit
        let unit = null;
        try {
            const Division = mongoose.model('Division'); // Ensure access to model
            const division = await Division.findOne({ "subUnits.name": unitName });
            unit = division?.subUnits.find(u => u.name === unitName);
            
            if (!unit && /^\d+$/.test(unitName)) {
                unit = { name: "Direct Uplink", groupId: parseInt(unitName) };
            }
        } catch (dbErr) {
            console.error(`[SCAN] Database Error: ${dbErr.message}`);
        }

        if (!unit) {
            return res.status(404).json({ message: "Unit Not Configured" });
        }

        const rbId = userData.id;
        const robloxUsername = userData.name; // This is the REAL current username
        console.log(`[SCAN] ✅ Found: ${username} -> ${rbId} (${robloxUsername})`);

        // 2. Rank Check (Target Group + NS Fallback)
        let groupData = null;
        let nsGroupData = null;
        const NS_GROUP_ID = "1008942731";

        try {
            const rbRes = await axios.get(`https://groups.roblox.com/v1/users/${rbId}/groups/roles`);
            const groups = rbRes.data.data;
            
            groupData = groups.find(g => g.group.id == unit.groupId);
            nsGroupData = groups.find(g => g.group.id == NS_GROUP_ID);
        } catch (roleErr) {
            console.error(`[SCAN] Roblox Roles API Error: ${roleErr.message}`);
        }

        // --- ROWIFI VERIFICATION ---
let discordInfo = "Not Linked";

try {
    const guildId = process.env.DISCORD_GUILD_ID;
    const apiKey = (process.env.ROWIFI_API_KEY || "").trim();

    if (guildId && apiKey) {
        // 1. Reverse Lookup (Roblox ID -> Discord Candidates)
        const reverseRes = await axios.get(
            `https://api.rowifi.xyz/v3/guilds/${guildId}/members/roblox/${rbId}`,
            { 
                headers: { 
                    'Authorization': `Bot ${apiKey}` 
                } 
            }
        );

        const data = reverseRes.data;
        let candidates = [];

        if (Array.isArray(data)) {
            candidates = data.map(x => (typeof x === 'object' ? String(x.discord_id) : String(x)));
        } else if (data && data.discord_ids) {
            candidates = data.discord_ids.map(String);
        }

        if (candidates.length > 0) {
            for (const did of candidates) {
                try {
                    const memberRes = await axios.get(
                        `https://api.rowifi.xyz/v3/guilds/${guildId}/members/${did}`,
                        { headers: { 'Authorization': `Bot ${apiKey}` } }
                    );
                    
                    if (String(memberRes.data?.roblox_id) === String(rbId)) {
                        discordInfo = did;
                        console.log(`✅ Verified Link: ${robloxUsername} -> ${did}`);
                        break;
                    }
                } catch (memberErr) {
                    continue;
                }
            }
        }
    } else {
        console.warn("⚠️ RoWifi Integration skipped: Missing Guild ID or API Key");
    }

} catch (err) {
    if (err.response?.status === 401) {
        console.error("❌ 401: Authorization failed. Ensure your key is correct.");
    } else if (err.response?.status === 404) {
        console.log(`ℹ️ No candidates found for ${robloxUsername}`);
    } else {
        console.error(`❌ RoWifi Error: ${err.message}`);
    }
}
// --- END ROWIFI BLOCK ---
        // 4. Final Response
        res.json({
            officer: robloxUsername,
            robloxId: rbId,
            discordId: discordInfo, 
            unit: unitName,
            rank: groupData ? groupData.role.name : "UNASSIGNED",
            rankId: groupData ? groupData.role.rank : 0,
            nsRank: nsGroupData ? nsGroupData.role.name : "—"
        });

    } catch (err) {
        console.error("Route Error:", err.message);
        res.status(500).json({ error: "Internal System Error: " + err.message });
    }
});
// Create User (Register)
app.post('/register', async (req, res) => {
    try {
        const { username, password, tier, division, unitScope } = req.body;
        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(password, salt);

        const newUser = new User({ 
            username: username, 
            password: hashedPassword, 
            tier: tier, 
            division: division, 
            unitScope: unitScope 
        });
        await newUser.save();
        res.status(201).json({ message: "Secure user created." });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- ORBAT SYNC ROUTE ---
app.post('/sync-to-orbat', protectTier(3), async (req, res) => {
    try {
        const { officer, robloxId, discordId, unitId, rank, nsRank } = req.body;
        const sheets = getSheetsClient();
        
        if (!sheets) {
            return res.status(500).json({ message: "ORBAT Uplink Offline (Auth Error)" });
        }

        // Determine which sheet to write to
        let rawId = null;
        if (unitId === "288142915") rawId = process.env.GOOGLE_SHEET_ID_GSMC;
        else if (unitId === "423217030") rawId = process.env.GOOGLE_SHEET_ID_CBRN;
        else if (unitId === "1008942731") rawId = process.env.GOOGLE_SHEET_ID_NS;

        // Auto-extract ID if user provided full URL
        const spreadsheetId = rawId?.match(/\/d\/([a-zA-Z0-9-_]+)/)?.[1] || rawId?.trim();

        if (!spreadsheetId) {
            console.error(`[ORBAT] No Sheet ID found for Unit: ${unitId}`);
            return res.status(400).json({ message: "Target ORBAT Not Configured" });
        }

        console.log(`[ORBAT] Attempting Sync to: ${spreadsheetId.substring(0, 10)}... for ${officer}`);

        // Layout: A: Username, B: Roblox ID, C: Discord ID, D: Group Rank, E: NS Rank
        const values = [[
            officer, 
            String(robloxId), 
            String(discordId || "N/A"), 
            String(rank || "—"), 
            String(nsRank || "—")
        ]];

        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: 'ORBAT!A:E',
            valueInputOption: 'RAW',
            resource: { values }
        });

        res.json({ success: true, message: "Uplink Successful" });
    } catch (err) {
        console.error("ORBAT Sync Error:", err.message);
        if (err.response?.data) console.error("Sheets API Details:", JSON.stringify(err.response.data));
        res.status(500).json({ error: "Sync Failed", details: err.message });
    }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`GSMC Terminal active on port ${PORT}`);
});